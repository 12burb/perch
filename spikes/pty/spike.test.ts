import { describe, expect, test } from "bun:test";
import { spawn as spawnBunPty } from "bun-pty";
import * as nodePty from "node-pty";

/**
 * Spike 0.4.1 — PTY on Bun (spec §9.3).
 * Pass criterion: a PTY opens a shell, resizes, and survives 1,000 writes on linux x64/arm64, macOS, Windows.
 *
 * Outcome on Bun 1.3.11 / linux x64 (ADR-0029): node-pty spawns and echoes, but `resize()` fails with
 * `ioctl(2) failed, EBADF` and sustained writes fail with EBADF, because Bun's `net.Socket({ fd })` does not
 * keep node-pty's master fd valid. bun-pty (a Bun-native PTY over FFI) passes the whole scenario, so bun-pty
 * is the PTY on Bun; node-pty stays only as an opt-in probe (PERCH_SPIKE_NODE_PTY=1) so the CI matrix can
 * re-check it per platform.
 */

const isWindows = process.platform === "win32";
const shell = isWindows ? "powershell.exe" : "/bin/sh";
const shellArgs = isWindows ? ["-NoLogo", "-NoProfile"] : [];

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms)),
  ]);
}

type Term = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (cb: (data: string) => void) => unknown;
  onExit: (cb: (e: { exitCode: number }) => void) => unknown;
  cols: number;
  rows: number;
};

async function scenario(term: Term): Promise<void> {
  let output = "";
  const waiters: Array<{ marker: string; resolve: () => void }> = [];
  term.onData((chunk) => {
    output += chunk;
    for (const w of [...waiters]) {
      if (output.includes(w.marker)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  });
  const waitFor = (marker: string, ms: number) =>
    withTimeout(
      new Promise<void>((resolve) => {
        if (output.includes(marker)) resolve();
        else waiters.push({ marker, resolve });
      }),
      ms,
      marker,
    );

  term.write("echo ready-marker\r");
  await waitFor("ready-marker", 15_000);

  term.resize(120, 40);
  expect(term.cols).toBe(120);
  expect(term.rows).toBe(40);
  term.write("echo after-resize\r");
  await waitFor("after-resize", 15_000);

  // 1,000 writes. A canonical-mode tty input queue holds ~4 KB, so writes go in batches that wait for the
  // shell to drain (a terminal drawer never outruns the line discipline either).
  const total = 1000;
  const batch = 20;
  for (let start = 0; start < total; start += batch) {
    const end = Math.min(start + batch, total);
    for (let i = start; i < end; i++) term.write(`echo line-${i}-done\r`);
    await waitFor(`line-${end - 1}-done`, 20_000);
  }
  expect(output).toContain("line-0-done");
  expect(output).toContain("line-999-done");

  const exited = new Promise<number>((resolve) => term.onExit((e) => resolve(e.exitCode)));
  term.write("exit\r");
  expect(await withTimeout(exited, 15_000, "exit")).toBe(0);
}

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

describe("spike 0.4.1 PTY on Bun — bun-pty", () => {
  test("opens a shell, resizes, and survives 1,000 writes", async () => {
    const term = spawnBunPty(shell, shellArgs, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env,
    });
    await scenario(term);
  }, 120_000);

  test("kill() ends a shell that does not exit on its own", async () => {
    const term = spawnBunPty(shell, shellArgs, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env,
    });
    const exited = new Promise<void>((resolve) => term.onExit(() => resolve()));
    term.kill();
    await withTimeout(exited, 15_000, "kill");
  }, 30_000);
});

describe.skipIf(!process.env.PERCH_SPIKE_NODE_PTY)(
  "spike 0.4.1 PTY on Bun — node-pty probe",
  () => {
    test("opens a shell, resizes, and survives 1,000 writes", async () => {
      const term = nodePty.spawn(shell, shellArgs, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env,
      });
      await scenario(term);
    }, 120_000);
  },
);
