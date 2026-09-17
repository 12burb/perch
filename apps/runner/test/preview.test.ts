import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerPolicy } from "../src/policy.ts";
import { PreviewManager, previewLogPath } from "../src/preview.ts";

/**
 * The project's dev server, started by the runner (task 4.8).
 *
 * The acceptance is that pressing Start runs the project's command where the project is, that
 * pressing it twice is one dev server rather than two, that Stop actually stops it, and that when
 * the command fails the log says why — because a preview that never comes up with no explanation
 * is the worst thing this can do.
 */

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
/** The capability token every §7.6 call carries; the manager never reads it. */
const CAP = "cap-for-tests";

const ctx = (root: string, project: string) => {
  const dir = join(root, WORKSPACE, project);
  mkdirSync(dir, { recursive: true });
  return { workspace_id: WORKSPACE, user_id: "someone", cap: CAP, project, dir };
};

function manager(root: string) {
  return new PreviewManager({ root, policy: runnerPolicy(), stopGraceMs: 500 });
}

/** Is that pid still there? Signal 0 asks without sending anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settles<T>(check: () => Promise<T> | T, want: (value: T) => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (want(value)) return value;
    if (Date.now() >= deadline) return value;
    await Bun.sleep(50);
  }
}

describe("the runner starts a project's dev server (task 4.8)", () => {
  test("it runs the command in the project, and says it is running", async () => {
    const root = mkdtempSync(join(tmpdir(), "perch-preview-"));
    const previews = manager(root);
    const one = ctx(root, "22222222-2222-4222-8222-222222222222");
    writeFileSync(join(one.dir, "hello.txt"), "here");
    const started = await previews.start({
      workspace_id: one.workspace_id,
      user_id: one.user_id,
      cap: CAP,
      project: one.project,
      // Prints where it is and then stays up, which is what a dev server does.
      command: "ls hello.txt && sleep 30",
    });
    expect(started.started).toBe(true);
    expect(started.running).toBe(true);
    expect(started.pid).toBeGreaterThan(0);
    expect(started.command).toContain("hello.txt");

    const log = await settles(
      async () => (await previews.status({ ...one, project: one.project })).log,
      (text) => text.includes("hello.txt"),
    );
    expect(log).toContain("hello.txt");
    expect(previewLogPath(root, one.project)).toContain(one.project);

    // Pressing Start again is not a second dev server.
    const again = await previews.start({
      workspace_id: one.workspace_id,
      user_id: one.user_id,
      cap: CAP,
      project: one.project,
      command: "sleep 30",
    });
    expect(again.started).toBe(false);
    expect(again.running).toBe(true);
    expect(again.pid).toBe(started.pid);

    const stopped = await previews.stop({ ...one, project: one.project });
    expect(stopped.running).toBe(false);
    const after = await previews.status({ ...one, project: one.project });
    expect(after.running).toBe(false);
    previews.closeAll();
  }, 20_000);

  test("a command that fails leaves its reason in the log", async () => {
    const root = mkdtempSync(join(tmpdir(), "perch-preview-"));
    const previews = manager(root);
    const one = ctx(root, "33333333-3333-4333-8333-333333333333");
    await previews.start({
      workspace_id: one.workspace_id,
      user_id: one.user_id,
      cap: CAP,
      project: one.project,
      command: "echo 'port 3000 is taken' >&2; exit 7",
    });
    const state = await settles(
      () => previews.status({ ...one, project: one.project }),
      (value) => value.running === false && value.log.includes("taken"),
    );
    expect(state.running).toBe(false);
    expect(state.exit_code).toBe(7);
    expect(state.log).toContain("port 3000 is taken");
    previews.closeAll();
  }, 20_000);

  test("stopping it takes the thing holding the port with it, not just the shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "perch-preview-"));
    const previews = manager(root);
    const one = ctx(root, "66666666-6666-4666-8666-666666666666");
    // The shell stays a shell and the dev server is its child — which is the shape npm, uv and
    // every other runner script produce, and the shape a plain kill of the shell would leave behind.
    const started = await previews.start({
      workspace_id: one.workspace_id,
      user_id: one.user_id,
      cap: CAP,
      project: one.project,
      command: "sleep 120 & echo child $! ; wait",
    });
    const log = await settles(
      async () => (await previews.status({ ...one, project: one.project })).log,
      (text) => /child \d+/.test(text),
    );
    const child = Number(/child (\d+)/.exec(log)?.[1]);
    expect(child).toBeGreaterThan(0);
    expect(alive(child)).toBe(true);
    expect(started.pid).not.toBe(child);

    await previews.stop({ ...one, project: one.project });
    const gone = await settles(
      () => alive(child),
      (value) => value === false,
      3000,
    );
    expect(gone).toBe(false);
    previews.closeAll();
  }, 20_000);

  test("a project this runner does not have is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "perch-preview-"));
    const previews = manager(root);
    await expect(
      previews.start({
        workspace_id: WORKSPACE,
        user_id: "someone",
        cap: CAP,
        project: "44444444-4444-4444-8444-444444444444",
        command: "sleep 1",
      }),
    ).rejects.toThrow(/not on this runner/);
    previews.closeAll();
  });

  test("nothing started means nothing running, and no log", async () => {
    const root = mkdtempSync(join(tmpdir(), "perch-preview-"));
    const previews = manager(root);
    const state = await previews.status({
      workspace_id: WORKSPACE,
      user_id: "someone",
      cap: CAP,
      project: "55555555-5555-4555-8555-555555555555",
    });
    expect(state).toMatchObject({ running: false, started: false, pid: null, log: "" });
  });
});
