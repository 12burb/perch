/**
 * The project's dev server, run by the runner (task 4.8, ADR-0154).
 *
 * Perch could already *watch* a port; nothing started one. A project made from a starter stack
 * says how to start itself in `.perch/project.json`, and this is what does it: one process per
 * project, held by the runner with its log, so Start twice is not two dev servers and closing the
 * tab is not none.
 *
 * It lives beside `exec` rather than inside it because `exec` has a budget and this has a lifetime,
 * and beside `pty` because a shell a person is typing in is not somewhere to type a command.
 */
import { existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import type { PreviewProcess, RunnerRequestParams } from "@perch/events";
import { cmdArgument, descendantsOf, killTree } from "./exec.ts";
import { enforce, type RunnerPolicy } from "./policy.ts";
import { projectDir } from "./projects.ts";

export type PreviewOptions = {
  root: string;
  policy: RunnerPolicy;
  /** How much of the log a status carries (default 8 KiB). */
  logBytes?: number;
  /** How long a stop waits for a polite exit before it stops being polite (default 3 s). */
  stopGraceMs?: number;
};

type Running = {
  proc: { pid: number; exited: Promise<number>; kill: (signal?: number | NodeJS.Signals) => void };
  command: string;
  startedAt: Date;
  log: string;
  exitCode: number | null;
};

/** Where a project's dev server writes: beside the projects, never inside one (git would see it). */
export function previewLogPath(root: string, projectId: string): string {
  return join(root, ".previews", `${projectId}.log`);
}

/**
 * The shell a dev server is started in: the project's command, exactly as somebody would type it.
 *
 * `cmd /s /c` strips the first and last quote of its argument, but only when the argument *begins*
 * with one — so `"C:\Program Files\bun.exe" dev.ts` arrives as something nobody asked to run. A
 * command in that shape is wrapped in one more pair, which is exactly what `/s` is for: it takes
 * the outermost pair off and runs the rest verbatim. Anything else is passed as it always was.
 */
export function shellFor(command: string, os: string = platform()): string[] {
  if (os !== "win32") return ["sh", "-c", command];
  return ["cmd.exe", "/d", "/s", "/c", cmdArgument(command)];
}

/** A signal that does not care whether the process is still there. */
function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // already gone
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

async function tailAsync(path: string, bytes: number): Promise<string> {
  try {
    const size = statSync(path).size;
    return await Bun.file(path)
      .slice(Math.max(0, size - bytes))
      .text();
  } catch {
    return "";
  }
}

export class PreviewManager {
  private readonly running = new Map<string, Running>();

  constructor(private readonly options: PreviewOptions) {}

  private async view(projectId: string, started: boolean): Promise<PreviewProcess> {
    const entry = this.running.get(projectId);
    const log = await tailAsync(
      entry?.log ?? previewLogPath(this.options.root, projectId),
      this.options.logBytes ?? 8 * 1024,
    );
    if (!entry) {
      return {
        running: false,
        started: false,
        pid: null,
        command: null,
        started_at: null,
        exit_code: null,
        log,
      };
    }
    const alive = entry.exitCode === null;
    return {
      running: alive,
      started: started && alive,
      pid: alive ? entry.proc.pid : null,
      command: entry.command,
      started_at: entry.startedAt.toISOString(),
      exit_code: entry.exitCode,
      log,
    };
  }

  /** Starts it, or says it is already running. The same command twice is one dev server. */
  async start(params: RunnerRequestParams<"preview.start">): Promise<PreviewProcess> {
    const existing = this.running.get(params.project);
    if (existing && existing.exitCode === null) return this.view(params.project, false);
    const cwd = projectDir(this.options.root, params.workspace_id, params.project);
    enforce(this.options.policy, {
      kind: "exec",
      command: params.command,
      cwd,
      root: this.options.root,
    });
    if (!existsSync(cwd)) throw new Error(`the project is not on this runner: ${params.project}`);
    const log = previewLogPath(this.options.root, params.project);
    mkdirSync(dirname(log), { recursive: true });
    // Truncated on every start: the log is this run's, not every run's.
    const fd = openSync(log, "w");
    const proc = Bun.spawn(shellFor(params.command), {
      cwd,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      env: { ...process.env, ...(params.env ?? {}), PERCH: "1", FORCE_COLOR: "0" },
    });
    const entry: Running = {
      proc,
      command: params.command,
      startedAt: new Date(),
      log,
      exitCode: null,
    };
    this.running.set(params.project, entry);
    void proc.exited.then((code) => {
      entry.exitCode = code;
    });
    return this.view(params.project, true);
  }

  /** Stops it: politely, then not. */
  async stop(params: RunnerRequestParams<"preview.stop">): Promise<PreviewProcess> {
    const entry = this.running.get(params.project);
    if (entry && entry.exitCode === null) {
      const grace = this.options.stopGraceMs ?? 3000;
      if (platform() === "win32") {
        // Windows has no polite signal and no way back to an orphan: take the whole tree in one
        // go, while the shell is still there for taskkill to hang it on.
        killTree(entry.proc, false);
        await Promise.race([entry.proc.exited, wait(grace)]);
      } else {
        // The tree is read before anything is killed: a shell that dies first leaves its children
        // reparented to init, and by then nothing on this side knows what they were.
        const tree = descendantsOf(entry.proc.pid);
        // Politely, and to all of them: a dev server told to stop closes its port and its children.
        entry.proc.kill();
        for (const pid of tree) signal(pid, "SIGTERM");
        await Promise.race([entry.proc.exited, wait(grace)]);
        // Then not politely, deepest first, including anything it started while we waited.
        for (const pid of [...descendantsOf(entry.proc.pid), ...tree].reverse()) {
          signal(pid, "SIGKILL");
        }
        if (entry.exitCode === null) {
          killTree(entry.proc, false);
          await Promise.race([entry.proc.exited, wait(grace)]);
        }
      }
    }
    const view = await this.view(params.project, false);
    this.running.delete(params.project);
    return { ...view, running: false, pid: null };
  }

  status(params: RunnerRequestParams<"preview.status">): Promise<PreviewProcess> {
    return this.view(params.project, false);
  }

  /** Every dev server this runner started, on the way down. */
  closeAll(): void {
    for (const entry of this.running.values()) {
      if (entry.exitCode === null) {
        try {
          // The tree, not just the shell: on the way down there is nobody left to reap an orphan.
          killTree(entry.proc, false);
        } catch {
          // already gone
        }
      }
    }
    this.running.clear();
  }
}
