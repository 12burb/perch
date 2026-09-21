/**
 * Shells on a runner (spec §5.1 terminal, §7.6 pty.*, task 1.7, ADR-0073): one PTY per pty_id,
 * spawned through bun-pty (ADR-0029), inside tmux where the machine has it (`new-session -A` so
 * the same person in the same project gets the same session back, even across runner restarts)
 * and a plain login shell elsewhere. Output goes to the stream the api opens for the stream token;
 * a shell whose stream closes stays alive for a grace period so a reload or a closed drawer
 * reattaches to it, scrollback replayed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { RunnerRequestParams, RunnerStream } from "@perch/events";
import { STREAM_OPEN_TIMEOUT_MS } from "@perch/events";
import type { IPty } from "bun-pty";
import { spawn } from "bun-pty";
import { childEnv } from "./env.ts";
import type { Notify } from "./notify.ts";
import type { StreamOpener } from "./streams.ts";

export type PtyOptions = {
  /** The projects root; a relative cwd resolves inside it. */
  root: string;
  /** Where hosted homes live (/data/homes/<user>); a user's directory there becomes HOME. */
  homes?: string;
  /** How long a detached shell survives without a stream (default 10 min). */
  graceMs?: number;
  /** How much recent output a reattaching stream gets (default 64 KiB). */
  scrollbackBytes?: number;
  /** tmux when available (default), or never. */
  tmux?: boolean;
  /** The shell to run when tmux is not used (default: $SHELL, else sh / powershell). */
  shell?: string;
  notify?: Notify;
  streams?: StreamOpener;
};

type Shell = {
  id: string;
  pty: IPty;
  scrollback: string;
  /** Output not yet folded into scrollback (a query might be split across chunks). */
  carry: () => string;
  stream: RunnerStream | null;
  detachStream: (() => void) | null;
  graceTimer: Timer | null;
  exited: boolean;
  exitCode: number | null;
  cwd: string;
  user: string;
};

let tmuxPath: string | null | undefined;
/** tmux, when the machine has it (never on Windows). */
export function tmux(): string | null {
  if (platform() === "win32") return null;
  if (tmuxPath === undefined) tmuxPath = Bun.which("tmux");
  return tmuxPath;
}

/** The tmux session for a person in a directory: stable, so a reattach finds it. */
export function tmuxSessionName(user: string, cwd: string): string {
  return `perch-${createHash("sha1").update(`${user}\n${cwd}`).digest("hex").slice(0, 12)}`;
}

function defaultShell(): string {
  if (platform() === "win32") return process.env.COMSPEC ?? "powershell.exe";
  return process.env.SHELL || "/bin/sh";
}

export function shellCommand(
  options: Pick<PtyOptions, "tmux" | "shell">,
  cwd: string,
  user: string,
  size: { cols: number; rows: number },
): { file: string; args: string[] } {
  const bin = options.tmux === false ? null : tmux();
  if (bin) {
    return {
      file: bin,
      args: [
        "-u",
        "new-session",
        "-A",
        "-s",
        tmuxSessionName(user, cwd),
        "-x",
        String(size.cols),
        "-y",
        String(size.rows),
        "-c",
        cwd,
        // Perch draws its own chrome; tmux's status line (black on green) fails contrast checks.
        ";",
        "set-option",
        "status",
        "off",
      ],
    };
  }
  const file = options.shell ?? defaultShell();
  return { file, args: platform() === "win32" ? [] : ["-l"] };
}

/**
 * Terminal queries the shell (or tmux) sent the terminal once: replaying them would make xterm answer
 * again, and the answers would land in the shell as keystrokes. Device attributes (DA1/DA2/DA3),
 * cursor and status reports (DSR), XTVERSION, mode queries (DECRQM), XTGETTCAP, kitty keyboard
 * queries, and OSC colour queries are dropped from the scrollback; everything else stays.
 */
const TERMINAL_QUERIES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are terminal escape sequences
  /\u001b\[(?:\??[0-9;]*)?[cn]|\u001b\[[>=](?:[0-9;]*)?c|\u001b\[>[0-9;]*q|\u001b\[\?[0-9;]*\$p|\u001b\[\?u|\u001bP\+q[^\u001b]*\u001b\\|\u001b\](?:4;\d+;\?|1[0-9];\?)[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripTerminalQueries(text: string): string {
  return text.replace(TERMINAL_QUERIES, "");
}

/**
 * A shell's environment: the runner's, with every PERCH_* variable blanked (they configure Perch's
 * own processes and carry its connect token, master key, and session secret; the vault-in,
 * gateway-out rule keeps them out of terminals and of anything started from one), plus TERM,
 * PERCH=1, PERCH_USER, and a HOME of their own under the homes directory when the runner has one.
 * Blanked rather than dropped: the PTY layer starts from the runner's real process environment and
 * merges what it is given on top, so a key left out would still reach the shell.
 */
export function shellEnv(
  options: Pick<PtyOptions, "homes">,
  user: string,
  base: NodeJS.ProcessEnv = process.env,
  project: Record<string, string> = {},
): Record<string, string> {
  const env = childEnv(base);
  // The project's own environment (task 2.13), after the runner's and before Perch's own names:
  // a project may set DATABASE_URL, and may not set PERCH_USER.
  for (const [key, value] of Object.entries(project))
    if (!key.startsWith("PERCH_")) env[key] = value;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.PERCH = "1";
  env.PERCH_USER = user;
  if (!env.LANG) env.LANG = "C.UTF-8";
  if (options.homes) {
    const home = join(options.homes, user);
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
    } catch {
      // a read-only homes directory: the runner's own HOME stays
    }
    if (existsSync(home)) env.HOME = home;
  }
  return env;
}

export class PtyManager {
  private readonly shells = new Map<string, Shell>();
  private readonly pending = new Map<string, { id: string; timer: Timer }>();

  constructor(private readonly options: PtyOptions) {}

  /** Opens a shell, or reattaches to one this runner still holds; answers with a stream token. */
  async open(params: RunnerRequestParams<"pty.open">): Promise<{
    stream_token: string;
    pty_id: string;
    reattached: boolean;
  }> {
    const existing = params.pty_id ? this.shells.get(params.pty_id) : undefined;
    const cwd = isAbsolute(params.cwd) ? params.cwd : resolve(this.options.root, params.cwd);
    let shell: Shell;
    let reattached = false;
    // A shell is reattached only by the person it belongs to, in the directory it runs in.
    if (existing && !existing.exited && existing.user === params.user && existing.cwd === cwd) {
      shell = existing;
      reattached = true;
      shell.pty.resize(params.cols, params.rows);
    } else {
      shell = this.spawn(params);
    }
    const token = crypto.randomUUID();
    const timer = setTimeout(() => {
      this.pending.delete(token);
    }, STREAM_OPEN_TIMEOUT_MS);
    timer.unref?.();
    this.pending.set(token, { id: shell.id, timer });
    // The socket runner opens the stream itself; the in-process runner pairs it when the api asks.
    if (this.options.streams) {
      this.options.streams
        .open(token)
        .then((stream) => this.attachToken(token, stream))
        .catch(() => {
          this.pending.delete(token);
        });
    }
    return { stream_token: token, pty_id: shell.id, reattached };
  }

  /** The api (in-process) or the socket client hands over the stream for a token. */
  attachToken(token: string, stream: RunnerStream): boolean {
    const entry = this.pending.get(token);
    if (!entry) {
      stream.close();
      return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(token);
    const shell = this.shells.get(entry.id);
    if (!shell || shell.exited) {
      stream.close();
      return false;
    }
    this.attach(shell, stream);
    return true;
  }

  private spawn(params: RunnerRequestParams<"pty.open">): Shell {
    const cwd = isAbsolute(params.cwd) ? params.cwd : resolve(this.options.root, params.cwd);
    if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${params.cwd}`);
    const size = { cols: params.cols, rows: params.rows };
    const command = shellCommand(this.options, cwd, params.user, size);
    const pty = spawn(command.file, command.args, {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      cwd,
      env: shellEnv(this.options, params.user, process.env, params.env ?? {}),
    });
    let carry = "";
    const shell: Shell = {
      id: crypto.randomUUID(),
      pty,
      scrollback: "",
      carry: () => carry,
      stream: null,
      detachStream: null,
      graceTimer: null,
      exited: false,
      exitCode: null,
      cwd,
      user: params.user,
    };
    const cap = this.options.scrollbackBytes ?? 64 * 1024;
    pty.onData((data) => {
      shell.stream?.send(data);
      // Queries may be split across chunks: keep a short tail unscanned until the next chunk.
      const scan = carry + data;
      const keep = Math.min(scan.length, 64);
      const settled = stripTerminalQueries(scan.slice(0, scan.length - keep));
      carry = scan.slice(scan.length - keep);
      shell.scrollback = (shell.scrollback + settled).slice(-cap);
    });
    pty.onExit((event) => {
      shell.exited = true;
      shell.exitCode = event.exitCode;
      this.options.notify?.({
        method: "pty.exit",
        params: { pty_id: shell.id, code: event.exitCode },
      });
      shell.stream?.close();
      this.dispose(shell);
    });
    this.shells.set(shell.id, shell);
    return shell;
  }

  private attach(shell: Shell, stream: RunnerStream): void {
    shell.detachStream?.();
    if (shell.graceTimer) clearTimeout(shell.graceTimer);
    shell.graceTimer = null;
    shell.stream = stream;
    const replay = shell.scrollback + stripTerminalQueries(shell.carry());
    if (replay) stream.send(replay);
    const offMessage = stream.onMessage((data) => shell.pty.write(data));
    const offClose = stream.onClose(() => {
      if (shell.stream !== stream) return;
      shell.stream = null;
      shell.detachStream = null;
      // Keep the shell for a while: a reload or a closed drawer comes back for it.
      shell.graceTimer = setTimeout(() => this.close(shell.id), this.options.graceMs ?? 600_000);
      shell.graceTimer.unref?.();
    });
    shell.detachStream = () => {
      offMessage();
      offClose();
      shell.detachStream = null;
    };
  }

  write(id: string, data: string): boolean {
    const shell = this.shells.get(id);
    if (!shell || shell.exited) return false;
    shell.pty.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const shell = this.shells.get(id);
    if (!shell || shell.exited) return false;
    shell.pty.resize(cols, rows);
    return true;
  }

  /** Ends a shell: the stream closes and the process is killed (a tmux session lives on). */
  close(id: string): boolean {
    const shell = this.shells.get(id);
    if (!shell) return false;
    if (!shell.exited) {
      shell.exited = true;
      try {
        shell.pty.kill();
      } catch {
        // already gone
      }
    }
    shell.stream?.close();
    this.dispose(shell);
    return true;
  }

  private dispose(shell: Shell): void {
    shell.detachStream?.();
    if (shell.graceTimer) clearTimeout(shell.graceTimer);
    shell.graceTimer = null;
    shell.stream = null;
    this.shells.delete(shell.id);
  }

  has(id: string): boolean {
    const shell = this.shells.get(id);
    return shell !== undefined && !shell.exited;
  }

  get size(): number {
    return this.shells.size;
  }

  /** Every shell down (runner shutdown). */
  closeAll(): void {
    for (const id of [...this.shells.keys()]) this.close(id);
    for (const [token, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(token);
    }
  }
}
