/**
 * exec on a runner (spec §7.6 "exec {command, cwd, timeout} (policy-checked)", task 1.5): one shell
 * command with a budget and capped output, confined by the policy hook (denied patterns; cwd inside
 * the projects root unless the policy says anywhere).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import type { RunnerRequestParams } from "@perch/events";
import { childEnv } from "./env.ts";
import { asUser } from "./identity.ts";
import { enforce, type RunnerPolicy } from "./policy.ts";
import { projectDir } from "./projects.ts";

export type ExecOptions = {
  root: string;
  policy: RunnerPolicy;
  /** Each of stdout and stderr is cut at this many bytes (default 1 MiB). */
  maxOutputBytes?: number;
};

export type ExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

/** What `cmd /s /c` must be handed for `command` to survive its quote-stripping rule. */
export function cmdArgument(command: string): string {
  return command.startsWith('"') ? `"${command}"` : command;
}

/** The shell, in its own process group where setsid exists so a timeout kills the whole tree. */
export function shell(
  command: string,
  os: string = platform(),
): { argv: string[]; group: boolean } {
  // A command that begins with a quote needs one more pair, or `/s` strips its first and last
  // quote and cmd runs something else entirely (task 4.8; the rule is in `cmdArgument`).
  if (os === "win32") {
    return { argv: ["cmd.exe", "/d", "/s", "/c", cmdArgument(command)], group: false };
  }
  const setsid = os === "linux" ? Bun.which("setsid") : null;
  return setsid
    ? { argv: [setsid, "-w", "sh", "-c", command], group: true }
    : { argv: ["sh", "-c", command], group: false };
}

/** Children of a pid from /proc, where a machine has one and may not have pgrep (task 4.8). */
function childrenFromProc(pid: number): number[] | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  const out: number[] = [];
  for (const entry of entries) {
    try {
      // `comm` can contain spaces and parentheses; the fields after it start at the last `)`.
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[1]) === pid) out.push(Number(entry));
    } catch {
      // the process went away between the listing and the read
    }
  }
  return out;
}

/** Children of a pid on a POSIX system without process groups (macOS): pgrep, best effort. */
export function childrenOf(pid: number): number[] {
  if (platform() === "linux") {
    const fromProc = childrenFromProc(pid);
    if (fromProc) return fromProc;
  }
  try {
    const result = Bun.spawnSync(["pgrep", "-P", String(pid)], { env: childEnv() });
    return result.stdout
      .toString()
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((child) => Number.isInteger(child) && child > 0);
  } catch {
    return [];
  }
}

/** Everything below a pid, deepest last: a shell's children, their children, and so on. */
export function descendantsOf(pid: number): number[] {
  const pending = [pid];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    pending.push(...childrenOf(next));
  }
  seen.delete(pid);
  return [...seen];
}

/**
 * Kills the shell and everything it started: the process group on Linux, taskkill's tree on
 * Windows (a lingering child would keep the directory busy), pgrep descendants elsewhere.
 */
export function killTree(
  proc: { pid: number; kill: (signal?: NodeJS.Signals | number) => void },
  group: boolean,
): void {
  if (platform() === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)], {
        stdout: "ignore",
        stderr: "ignore",
        env: childEnv(),
      });
    } catch {
      // taskkill missing: fall through to the plain kill
    }
  } else if (group) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // the group is already gone
    }
  } else {
    for (const pid of descendantsOf(proc.pid).reverse()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  proc.kill("SIGKILL");
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text;
}

/** Collects a stream; `stop` abandons it (a killed shell's grandchildren may still hold the pipe). */
function collect(stream: ReadableStream<Uint8Array>): { text: Promise<string>; stop: () => void } {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let stopped = false;
  const text = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
    } catch {
      // cancelled
    }
    return out;
  })();
  return {
    text,
    stop: () => {
      if (stopped) return;
      stopped = true;
      void reader.cancel().catch(() => {});
    },
  };
}

export async function exec(
  options: ExecOptions,
  params: RunnerRequestParams<"exec">,
): Promise<ExecResult> {
  // A caller that names a project rather than a directory gets the project's own (task 3.18):
  // where a project lives is the runner's business, and the policy hook still sees the answer.
  const where =
    params.cwd ??
    (params.project ? projectDir(options.root, params.workspace_id, params.project) : ".");
  const cwd = resolve(options.root, where);
  enforce(options.policy, {
    kind: "exec",
    command: params.command,
    cwd,
    root: resolve(options.root),
  });
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${where}`);
  const started = performance.now();
  const { argv, group } = shell(params.command);
  // As the member who asked (ADR-0171): setpriv execs setsid execs sh, one pid all the way, so the
  // process group a timeout kills is still this child's.
  const run = asUser(
    params.user_id,
    argv,
    childEnv(process.env, { PERCH: "1", CI: process.env.CI ?? "1" }),
  );
  const proc = Bun.spawn(run.argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: run.env,
  });
  const out = collect(proc.stdout);
  const err = collect(proc.stderr);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(proc, group);
    out.stop();
    err.stop();
  }, params.timeout);
  const [stdout, stderr, exitCode] = await Promise.all([out.text, err.text, proc.exited]);
  clearTimeout(timer);
  const max = options.maxOutputBytes ?? 1024 * 1024;
  return {
    exitCode: timedOut ? null : exitCode,
    stdout: cap(stdout, max),
    stderr: cap(stderr, max),
    timedOut,
    durationMs: Math.round(performance.now() - started),
  };
}
