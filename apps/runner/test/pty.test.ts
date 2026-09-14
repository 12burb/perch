import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerNotification, RunnerStream } from "@perch/events";
import {
  PtyManager,
  shellCommand,
  shellEnv,
  stripTerminalQueries,
  tmux,
  tmuxSessionName,
} from "../src/pty.ts";
import { createStreamPair } from "../src/streams.ts";

/**
 * Task 1.7: a shell per pty_id behind a stream token; output on the stream, input from it; a
 * detached shell survives for the grace period and a reopen with its pty_id reattaches with the
 * scrollback replayed; exit is reported; tmux sessions are named for the person and directory.
 */

const WS = "0190f2d0-0000-7000-8000-000000000001";
const USER = "0190f2d0-0000-7000-8000-0000000000aa";
const ctx = { workspace_id: WS, user_id: USER, cap: "test" } as const;
const win = process.platform === "win32";

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "perch-pty-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Collects a stream's output and resolves once a marker shows up. */
function tap(stream: RunnerStream) {
  let output = "";
  const waiters: { marker: string; resolve: () => void }[] = [];
  stream.onMessage((data) => {
    output += data;
    for (const waiter of [...waiters]) {
      if (output.includes(waiter.marker)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });
  return {
    get output() {
      return output;
    },
    waitFor: (marker: string, ms = 20_000) =>
      new Promise<void>((resolve, reject) => {
        if (output.includes(marker)) return resolve();
        const timer = setTimeout(() => reject(new Error(`no "${marker}" in:\n${output}`)), ms);
        waiters.push({
          marker,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      }),
  };
}

describe("shells on a runner (task 1.7)", () => {
  test("open, talk, resize, detach, reattach with scrollback, close", async () => {
    const notifications: RunnerNotification[] = [];
    const manager = new PtyManager({
      root,
      tmux: false,
      graceMs: 60_000,
      notify: (n) => notifications.push(n),
    });
    try {
      const opened = await manager.open({ ...ctx, cols: 80, rows: 24, cwd: ".", user: USER });
      expect(opened.pty_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(opened.reattached).toBe(false);
      const first = createStreamPair();
      expect(manager.attachToken(opened.stream_token, first.b)).toBe(true);
      // A token is single-use.
      expect(manager.attachToken(opened.stream_token, createStreamPair().b)).toBe(false);
      const out = tap(first.a);
      first.a.send("echo perch-pty-one\r");
      await out.waitFor("perch-pty-one");
      expect(manager.resize(opened.pty_id, 120, 40)).toBe(true);
      expect(manager.write(opened.pty_id, "echo perch-pty-two\r")).toBe(true);
      await out.waitFor("perch-pty-two");

      // Detach: the shell stays for the grace period; reopening with the id reattaches and replays.
      first.a.close();
      await Bun.sleep(50);
      expect(manager.has(opened.pty_id)).toBe(true);
      const again = await manager.open({
        ...ctx,
        cols: 100,
        rows: 30,
        cwd: ".",
        user: USER,
        pty_id: opened.pty_id,
      });
      expect(again.pty_id).toBe(opened.pty_id);
      expect(again.reattached).toBe(true);
      const second = createStreamPair();
      const replay = tap(second.a);
      expect(manager.attachToken(again.stream_token, second.b)).toBe(true);
      await replay.waitFor("perch-pty-one", 5_000);
      await replay.waitFor("perch-pty-two", 5_000);
      second.a.send("echo perch-pty-three\r");
      await replay.waitFor("perch-pty-three");

      expect(manager.close(opened.pty_id)).toBe(true);
      expect(manager.has(opened.pty_id)).toBe(false);
      expect(second.a.closed).toBe(true);
      expect(manager.write(opened.pty_id, "x")).toBe(false);

      // A shell that exits on its own says so.
      const exiting = await manager.open({ ...ctx, cols: 80, rows: 24, cwd: ".", user: USER });
      const stream = createStreamPair();
      manager.attachToken(exiting.stream_token, stream.b);
      stream.a.send("exit\r");
      const exited = () =>
        notifications.find(
          (n) =>
            n.method === "pty.exit" && (n.params as { pty_id: string }).pty_id === exiting.pty_id,
        );
      const deadline = Date.now() + 20_000;
      while (!exited() && Date.now() < deadline) await Bun.sleep(50);
      expect(exited()?.params).toMatchObject({ pty_id: exiting.pty_id });
      expect(manager.has(exiting.pty_id)).toBe(false);
      expect(stream.a.closed).toBe(true);
    } finally {
      manager.closeAll();
    }
  }, 60_000);

  test("someone else's pty_id, or one from another directory, starts a fresh shell", async () => {
    const manager = new PtyManager({ root, tmux: false, graceMs: 60_000 });
    try {
      const mine = await manager.open({ ...ctx, cols: 80, rows: 24, cwd: ".", user: USER });
      const other = "0190f2d0-0000-7000-8000-0000000000bb";
      const theirs = await manager.open({
        ...ctx,
        cols: 80,
        rows: 24,
        cwd: ".",
        user: other,
        pty_id: mine.pty_id,
      });
      expect(theirs.reattached).toBe(false);
      expect(theirs.pty_id).not.toBe(mine.pty_id);
      mkdirSync(join(root, "elsewhere"), { recursive: true });
      const elsewhere = await manager.open({
        ...ctx,
        cols: 80,
        rows: 24,
        cwd: "elsewhere",
        user: USER,
        pty_id: mine.pty_id,
      });
      expect(elsewhere.reattached).toBe(false);
      expect(elsewhere.pty_id).not.toBe(mine.pty_id);
      const again = await manager.open({
        ...ctx,
        cols: 80,
        rows: 24,
        cwd: ".",
        user: USER,
        pty_id: mine.pty_id,
      });
      expect(again).toMatchObject({ pty_id: mine.pty_id, reattached: true });
    } finally {
      manager.closeAll();
    }
  }, 30_000);

  test("terminal queries are dropped from the scrollback so a replay cannot answer them", () => {
    const queries =
      "\u001b[c\u001b[>c\u001b[=c\u001b[6n\u001b[5n\u001b[>q\u001b[?2026$p\u001b[?u\u001bP+q544e\u001b\\\u001b]10;?\u0007\u001b]4;1;?\u001b\\";
    expect(stripTerminalQueries(`a${queries}b`)).toBe("ab");
    // Ordinary control sequences survive: colours, clears, cursor moves, the alternate screen.
    const keep =
      "\u001b[31mred\u001b[0m \u001b[2J\u001b[H\u001b[?1049h\u001b[?25l\u001b]0;title\u0007";
    expect(stripTerminalQueries(keep)).toBe(keep);
  });

  test("a bad cwd and an unknown token are refused; a token expires", async () => {
    const manager = new PtyManager({ root, tmux: false });
    await expect(
      manager.open({ ...ctx, cols: 80, rows: 24, cwd: "missing-dir", user: USER }),
    ).rejects.toThrow(/cwd does not exist/);
    expect(manager.attachToken("nope", createStreamPair().b)).toBe(false);
    expect(manager.resize("nope", 1, 1)).toBe(false);
    expect(manager.close("nope")).toBe(false);
    manager.closeAll();
  });

  test("the shell's environment: PERCH_USER and a home per person, never Perch's own secrets", () => {
    const homes = join(root, "homes");
    const env = shellEnv({ homes }, USER, {
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/sh",
      HOME: "/runner",
      OPENAI_API_KEY: "sk-the-users-own",
      PERCH_RUNNER_TOKEN: "prt_secret",
      PERCH_MASTER_KEY: "master",
      PERCH_SESSION_SECRET: "session",
      PERCH_API_URL: "http://api.internal",
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/sh",
      OPENAI_API_KEY: "sk-the-users-own",
      TERM: "xterm-256color",
      PERCH: "1",
      PERCH_USER: USER,
      HOME: join(homes, USER),
    });
    // Blanked, not dropped: the PTY layer merges the runner's real environment underneath.
    const perchKeys = Object.entries(env).filter(([k]) => k.startsWith("PERCH_"));
    expect(perchKeys).toEqual([
      ["PERCH_RUNNER_TOKEN", ""],
      ["PERCH_MASTER_KEY", ""],
      ["PERCH_SESSION_SECRET", ""],
      ["PERCH_API_URL", ""],
      ["PERCH_USER", USER],
    ]);
    expect(existsSync(join(homes, USER))).toBe(true);
    // Without a homes directory (a local runner, laptop mode) the runner's HOME stays.
    expect(shellEnv({}, USER, { HOME: "/me" }).HOME).toBe("/me");
    // A shell of a runner that was started with the token in its real environment never sees it.
    const probe = Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, "helpers", "pty-env-probe.ts"), root, USER],
      env: { ...process.env, PERCH_RUNNER_TOKEN: "prt_leaked" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(probe.exitCode, probe.stderr.toString()).toBe(0);
    const line =
      probe.stdout
        .toString()
        .split("\n")
        .find((l) => l.startsWith("PROBE ")) ?? "";
    expect(line).toContain(`user=[${USER}]`);
    expect(line).not.toContain("prt_leaked");
  }, 60_000);

  test("the shell command: tmux sessions are named for the person and directory", () => {
    expect(tmuxSessionName(USER, "/p/a")).toBe(tmuxSessionName(USER, "/p/a"));
    expect(tmuxSessionName(USER, "/p/a")).not.toBe(tmuxSessionName(USER, "/p/b"));
    expect(tmuxSessionName(USER, "/p/a")).toMatch(/^perch-[0-9a-f]{12}$/);
    const plain = shellCommand({ tmux: false, shell: "/bin/zsh" }, "/p/a", USER, {
      cols: 80,
      rows: 24,
    });
    expect(plain).toEqual({ file: "/bin/zsh", args: win ? [] : ["-l"] });
    if (tmux()) {
      const viaTmux = shellCommand({}, "/p/a", USER, { cols: 80, rows: 24 });
      expect(viaTmux.file).toBe(tmux() ?? "");
      expect(viaTmux.args).toEqual([
        "-u",
        "new-session",
        "-A",
        "-s",
        tmuxSessionName(USER, "/p/a"),
        "-x",
        "80",
        "-y",
        "24",
        "-c",
        "/p/a",
        ";",
        "set-option",
        "status",
        "off",
      ]);
    }
  });

  test.skipIf(!tmux())(
    "with tmux, the same person in the same directory gets their session back",
    async () => {
      const manager = new PtyManager({ root, graceMs: 60_000 });
      const name = tmuxSessionName(USER, root);
      try {
        const first = await manager.open({ ...ctx, cols: 80, rows: 24, cwd: ".", user: USER });
        const a = createStreamPair();
        manager.attachToken(first.stream_token, a.b);
        const out = tap(a.a);
        // Keystrokes sent before tmux has drawn its screen are lost: wait for its first redraw.
        await out.waitFor("\u001b[?1049h");
        // State that only this shell process has: proof of the same shell coming back.
        a.a.send("PERCH_TMUX_TEST=alive; echo perch-tmux-marker\r");
        await out.waitFor("perch-tmux-marker");
        // Kill the client PTY (the runner restarting); the tmux session lives on.
        manager.close(first.pty_id);
        const listed = Bun.spawnSync(["tmux", "ls", "-F", "#{session_name}"]).stdout.toString();
        expect(listed).toContain(name);
        const second = await manager.open({ ...ctx, cols: 80, rows: 24, cwd: ".", user: USER });
        const b = createStreamPair();
        const again = tap(b.a);
        manager.attachToken(second.stream_token, b.b);
        await again.waitFor("\u001b[?1049h");
        b.a.send("echo $PERCH_TMUX_TEST-check\r");
        await again.waitFor("alive-check");
        manager.close(second.pty_id);
      } finally {
        manager.closeAll();
        Bun.spawnSync(["tmux", "kill-session", "-t", name]);
      }
    },
    60_000,
  );
});
