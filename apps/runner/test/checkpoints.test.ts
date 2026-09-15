import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunnerNotification, selectHunks } from "@perch/events";
import { checkpoint, checkpointRef, gitApply, restore } from "../src/checkpoints.ts";
import { gitDiff } from "../src/git.ts";
import { runnerPolicy } from "../src/policy.ts";
import { projectDir, setupProject } from "../src/projects.ts";

/**
 * Task 1.13: a checkpoint is the working tree before a turn (untracked files included) on
 * refs/perch/checkpoints/<session>/<turn>; git.diff against it sees new files; git.apply reverses
 * one hunk; restore puts the tree back, removing files that did not exist then.
 */

const WS = "0190f2d0-0000-7000-8000-000000000001";
const USER = "0190f2d0-0000-7000-8000-0000000000aa";
const PROJECT = "0190f2d0-0000-7000-8000-0000000000de";
const SESSION = "0190f2d0-0000-7000-8000-0000000000c1";
const ctx = { workspace_id: WS, user_id: USER, cap: "test", project: PROJECT } as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function project(): Promise<{ root: string; dir: string }> {
  const root = mkdtempSync(join(tmpdir(), "perch-ckpt-"));
  dirs.push(root);
  await setupProject({ root }, { ...ctx, source: { kind: "empty", defaultBranch: "main" } });
  return { root, dir: projectDir(root, WS, PROJECT) };
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

const lines = (n: number) => `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

describe("checkpoints, diffs, and restores (task 1.13)", () => {
  test("checkpoint → diff with three hunks and a new file → reject one hunk → restore", async () => {
    const { root, dir } = await project();
    const notifications: RunnerNotification[] = [];
    const opts = {
      root,
      policy: runnerPolicy(),
      notify: (n: RunnerNotification) => notifications.push(n),
    };
    writeFileSync(join(dir, "notes.txt"), lines(30));
    writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
    writeFileSync(join(dir, "ignored.log"), "noise\n");

    // Turn 1's checkpoint: an untracked file on an unborn branch is still captured.
    const first = await checkpoint(opts, { ...ctx, session_id: SESSION, turn: 1 });
    expect(first.git_ref).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, "rev-parse", checkpointRef(SESSION, 1))).toBe(first.git_ref);
    expect(git(dir, "ls-tree", "--name-only", first.git_ref).split("\n").sort()).toEqual([
      ".gitignore",
      "notes.txt",
    ]);
    expect(git(dir, "status", "--porcelain")).toContain("?? notes.txt"); // the index is untouched

    // The agent edits three far-apart lines and adds a file.
    const edited = lines(30)
      .split("\n")
      .map((l) => (["line 2", "line 15", "line 28"].includes(l) ? `${l} (edited)` : l))
      .join("\n");
    writeFileSync(join(dir, "notes.txt"), edited);
    writeFileSync(join(dir, "extra.txt"), "extra\n");
    const diff = await gitDiff(opts, { ...ctx, ref: first.git_ref });
    expect(diff.patches.map((p) => [p.path, p.status, p.additions, p.deletions])).toEqual([
      ["extra.txt", "added", 1, 0],
      ["notes.txt", "modified", 3, 3],
    ]);
    expect(diff.files).toEqual([
      { path: "extra.txt", additions: 1, deletions: 0, binary: false },
      { path: "notes.txt", additions: 3, deletions: 3, binary: false },
    ]);
    const notes = diff.patches[1];
    if (!notes) throw new Error("no notes.txt patch");
    expect(notes.patch.match(/^@@ /gm)).toHaveLength(3);

    // Turn 2's checkpoint; a range between two checkpoints reads the same.
    const second = await checkpoint(opts, { ...ctx, session_id: SESSION, turn: 2 });
    const between = await gitDiff(opts, { ...ctx, ref: first.git_ref, to: second.git_ref });
    expect(between.diff).toBe(diff.diff);

    // Rejecting the third hunk (line 28) reverse-applies just that hunk.
    const rejected = await gitApply(opts, {
      ...ctx,
      patch: selectHunks(notes.patch, [2]),
      reverse: true,
    });
    expect(rejected).toEqual({ files: ["notes.txt"] });
    const after = readFileSync(join(dir, "notes.txt"), "utf8");
    expect(after).toContain("line 2 (edited)");
    expect(after).toContain("line 15 (edited)");
    expect(after).toContain("\nline 28\n");
    expect(notifications.at(-1)).toEqual({
      method: "fs.changed",
      params: { project: PROJECT, paths: ["notes.txt"], kind: "change" },
    });
    // A hunk whose context moved on does not apply, and says so.
    writeFileSync(join(dir, "notes.txt"), after.replace("line 30", "line 30 (later)"));
    await expect(
      gitApply(opts, { ...ctx, patch: selectHunks(notes.patch, [2]), reverse: true }),
    ).rejects.toThrow(/does not apply/);
    // Since turn 2: the rejected line and the later edit, close enough to share one hunk.
    const since = await gitDiff(opts, { ...ctx, ref: second.git_ref });
    expect(since.patches.map((p) => [p.path, p.additions, p.deletions])).toEqual([
      ["notes.txt", 2, 2],
    ]);
    expect(since.patches[0]?.patch.match(/^@@ /gm)).toHaveLength(1);

    // Restoring turn 1 rewrites notes.txt and removes extra.txt; ignored files stay.
    const restored = await restore(opts, { ...ctx, session_id: SESSION, turn: 1 });
    expect(restored.git_ref).toBe(first.git_ref);
    expect(restored.files.sort()).toEqual(["extra.txt", "notes.txt"]);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe(lines(30));
    expect(existsSync(join(dir, "extra.txt"))).toBe(false);
    expect(existsSync(join(dir, "ignored.log"))).toBe(true);
    expect(notifications.slice(-2)).toEqual([
      { method: "fs.changed", params: { project: PROJECT, paths: ["notes.txt"], kind: "change" } },
      { method: "fs.changed", params: { project: PROJECT, paths: ["extra.txt"], kind: "delete" } },
    ]);
    // Nothing to do the second time; an unknown turn is refused.
    expect(await restore(opts, { ...ctx, session_id: SESSION, turn: 1 })).toEqual({
      git_ref: first.git_ref,
      files: [],
    });
    await expect(restore(opts, { ...ctx, session_id: SESSION, turn: 9 })).rejects.toThrow(
      /no checkpoint for turn 9/,
    );
  }, 30_000);

  test("paths with spaces and unicode, and files with CRLF, survive the whole round trip", async () => {
    const { root, dir } = await project();
    const opts = { root, policy: runnerPolicy() };
    const spacey = "notes and things/a file \u2014 \u00fcn\u00efcode.txt";
    mkdirSync(join(dir, "notes and things"), { recursive: true });
    writeFileSync(join(dir, spacey), "one\ntwo\nthree\n");
    writeFileSync(join(dir, "crlf.txt"), "a\r\nb\r\nc\r\n");
    const first = await checkpoint(opts, { ...ctx, session_id: SESSION, turn: 1 });

    writeFileSync(join(dir, spacey), "one\nTWO\nthree\n");
    writeFileSync(join(dir, "crlf.txt"), "a\r\nB\r\nc\r\n");
    const diff = await gitDiff(opts, { ...ctx, ref: first.git_ref });
    expect(diff.patches.map((p) => p.path).sort()).toEqual(["crlf.txt", spacey].sort());

    // The patch names the file the same way, so rejecting its hunk finds it.
    const target = diff.patches.find((p) => p.path === spacey);
    if (!target) throw new Error("no patch for the path with spaces");
    expect(
      await gitApply(opts, { ...ctx, patch: selectHunks(target.patch, [0]), reverse: true }),
    ).toEqual({ files: [spacey] });
    expect(readFileSync(join(dir, spacey), "utf8")).toBe("one\ntwo\nthree\n");

    const restored = await restore(opts, { ...ctx, session_id: SESSION, turn: 1 });
    expect(restored.files).toEqual(["crlf.txt"]);
    expect(readFileSync(join(dir, "crlf.txt"), "utf8")).toBe("a\r\nb\r\nc\r\n");
    expect(readFileSync(join(dir, spacey), "utf8")).toBe("one\ntwo\nthree\n");
  }, 30_000);

  test("a repository that converts line endings does not get its files rewritten", async () => {
    const { root, dir } = await project();
    const opts = { root, policy: runnerPolicy() };
    // What Git for Windows does by default, and what broke the round trip there.
    git(dir, "config", "core.autocrlf", "true");
    writeFileSync(join(dir, "unix.txt"), "one\ntwo\nthree\n");
    const first = await checkpoint(opts, { ...ctx, session_id: SESSION, turn: 1 });

    writeFileSync(join(dir, "unix.txt"), "one\nTWO\nthree\n");
    const diff = await gitDiff(opts, { ...ctx, ref: first.git_ref });
    const patch = diff.patches[0];
    if (!patch) throw new Error("no patch");
    await gitApply(opts, { ...ctx, patch: selectHunks(patch.patch, [0]), reverse: true });
    expect(readFileSync(join(dir, "unix.txt"), "utf8")).toBe("one\ntwo\nthree\n");

    writeFileSync(join(dir, "unix.txt"), "one\ntwo\nthree\nfour\n");
    await restore(opts, { ...ctx, session_id: SESSION, turn: 1 });
    expect(readFileSync(join(dir, "unix.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  }, 30_000);

  test("a restore takes the commit the api names, whoever's ref holds it", async () => {
    const { root, dir } = await project();
    const opts = { root, policy: runnerPolicy() };
    writeFileSync(join(dir, "keep.txt"), "one\n");
    const first = await checkpoint(opts, { ...ctx, session_id: SESSION, turn: 1 });
    writeFileSync(join(dir, "keep.txt"), "two\n");

    // A fork: another session id, no ref of its own, the same commit.
    const forked = "0190f2d0-0000-7000-8000-0000000000c2";
    await expect(restore(opts, { ...ctx, session_id: forked, turn: 1 })).rejects.toThrow(
      /no checkpoint for turn 1/,
    );
    const restored = await restore(opts, {
      ...ctx,
      session_id: forked,
      turn: 1,
      git_ref: first.git_ref,
    });
    expect(restored).toEqual({ git_ref: first.git_ref, files: ["keep.txt"] });
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("one\n");
    // A commit that is not there is refused, not guessed at.
    await expect(
      restore(opts, { ...ctx, session_id: forked, turn: 1, git_ref: "0".repeat(40) }),
    ).rejects.toThrow(/no checkpoint for turn 1/);
  }, 30_000);

  test("a restore brings back a file deleted since, and the policy guards every path", async () => {
    const { root, dir } = await project();
    const opts = { root, policy: runnerPolicy() };
    writeFileSync(join(dir, "keep.txt"), "keep\n");
    const first = await checkpoint(opts, { ...ctx, session_id: SESSION, turn: 1 });
    rmSync(join(dir, "keep.txt"));
    const restored = await restore(opts, { ...ctx, session_id: SESSION, turn: 1 });
    expect(restored).toEqual({ git_ref: first.git_ref, files: ["keep.txt"] });
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("keep\n");

    const patch = `diff --git a/.git/config b/.git/config
--- a/.git/config
+++ b/.git/config
@@ -1 +1 @@
-x
+y
`;
    await expect(gitApply(opts, { ...ctx, patch })).rejects.toThrow(/policy denied/);
    await expect(gitApply(opts, { ...ctx, patch: "not a patch\n" })).rejects.toThrow(
      /names no files/,
    );
    const stale = `diff --git a/keep.txt b/keep.txt
--- a/keep.txt
+++ b/keep.txt
@@ -1 +1 @@
-something else
+keep
`;
    await expect(gitApply(opts, { ...ctx, patch: stale })).rejects.toThrow(/does not apply/);
  }, 30_000);
});
