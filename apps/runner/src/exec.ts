/**
 * exec on a runner (spec §7.6 "exec {command, cwd, timeout} (policy-checked)", task 1.5): one shell
 * command with a budget and capped output, confined by the policy hook (denied patterns; cwd inside
 * the projects root unless the policy says anywhere).
 */
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import type { RunnerRequestParams } from "@perch/events";
import { enforce, type RunnerPolicy } from "./policy.ts";

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

/** The shell, in its own process group where setsid exists so a timeout kills the whole tree. */
function shell(command: string): { argv: string[]; group: boolean } {
  if (platform() === "win32") return { argv: ["cmd.exe", "/d", "/s", "/c", command], group: false };
  const setsid = platform() === "linux" ? Bun.which("setsid") : null;
  return setsid
    ? { argv: [setsid, "-w", "sh", "-c", command], group: true }
    : { argv: ["sh", "-c", command], group: false };
}

/** Children of a pid on a POSIX system without process groups (macOS): pgrep, best effort. */
function childrenOf(pid: number): number[] {
  try {
    const result = Bun.spawnSync(["pgrep", "-P", String(pid)]);
    return result.stdout
      .toString()
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((child) => Number.isInteger(child) && child > 0);
  } catch {
    return [];
  }
}

/**
 * Kills the shell and everything it started: the process group on Linux, taskkill's tree on
 * Windows (a lingering child would keep the directory busy), pgrep descendants elsewhere.
 */
function killTree(
  proc: { pid: number; kill: (signal?: NodeJS.Signals | number) => void },
  group: boolean,
): void {
  if (platform() === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)], {
        stdout: "ignore",
        stderr: "ignore",
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
    const pending = [proc.pid];
    const seen = new Set<number>();
    while (pending.length > 0) {
      const pid = pending.pop();
      if (pid === undefined || seen.has(pid)) continue;
      seen.add(pid);
      pending.push(...childrenOf(pid));
    }
    for (const pid of [...seen].reverse()) {
      if (pid === proc.pid) continue;
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
  const cwd = resolve(options.root, params.cwd);
  enforce(options.policy, {
    kind: "exec",
    command: params.command,
    cwd,
    root: resolve(options.root),
  });
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${params.cwd}`);
  const started = performance.now();
  const { argv, group } = shell(params.command);
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PERCH: "1", CI: process.env.CI ?? "1" },
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
