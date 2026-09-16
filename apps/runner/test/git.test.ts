import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitBranch,
  gitCommit,
  gitDiff,
  gitMerge,
  gitPush,
  gitStatus,
  worktreeCreate,
  worktreeRemove,
} from "../src/git.ts";
import { PolicyDenied, runnerPolicy } from "../src/policy.ts";
import { projectDir, setupProject } from "../src/projects.ts";

/**
 * Task 1.5: git.status/diff/commit/push/branch and worktree.create/remove on a project, with the
 * policy hook on the writes; the push lands on a local bare remote.
 */

const WS = "0190f2d0-0000-7000-8000-000000000001";
const USER = "0190f2d0-0000-7000-8000-0000000000aa";
const PROJECT = "0190f2d0-0000-7000-8000-0000000000dd";
const ctx = { workspace_id: WS, user_id: USER, cap: "test", project: PROJECT } as const;
const author = { name: "Perch Tests", email: "tests@perch.test" };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function project(): Promise<{ root: string; dir: string }> {
  const root = mkdtempSync(join(tmpdir(), "perch-git-"));
  dirs.push(root);
  await setupProject({ root }, { ...ctx, source: { kind: "empty", defaultBranch: "main" } });
  return { root, dir: projectDir(root, WS, PROJECT) };
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

describe("git methods (task 1.5)", () => {
  test("status, commit, diff, and branches on a fresh project", async () => {
    const { root, dir } = await project();
    const opts = { root, policy: runnerPolicy() };
    writeFileSync(join(dir, "a.txt"), "one\n");
    writeFileSync(join(dir, "b.txt"), "two\n");

    const before = await gitStatus(opts, ctx);
    expect(before).toMatchObject({ branch: "main", clean: false, ahead: 0, behind: 0 });
    expect(before.files.map((f) => `${f.path}:${f.index}${f.workingTree}`).sort()).toEqual([
      "a.txt:??",
      "b.txt:??",
    ]);
    // An unborn branch still answers diff (the index).
    expect(await gitDiff(opts, ctx)).toEqual({ diff: "", files: [], patches: [] });

    const first = await gitCommit(opts, { ...ctx, message: "first", author });
    expect(first.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(first.branch).toBe("main");
    expect(first.summary.changes).toBe(2);
    expect(git(dir, "log", "-1", "--format=%an <%ae>")).toBe("Perch Tests <tests@perch.test>");
    expect(await gitStatus(opts, ctx)).toMatchObject({ clean: true, files: [] });
    await expect(gitCommit(opts, { ...ctx, message: "empty", author })).rejects.toThrow(
      /nothing to commit/,
    );

    writeFileSync(join(dir, "a.txt"), "one\nthree\n");
    const diff = await gitDiff(opts, ctx);
    expect(diff.diff).toContain("+three");
    expect(diff.files).toEqual([{ path: "a.txt", additions: 1, deletions: 0, binary: false }]);
    // Only the named paths go into the commit.
    writeFileSync(join(dir, "c.txt"), "c\n");
    const second = await gitCommit(opts, { ...ctx, message: "second", paths: ["a.txt"], author });
    expect(second.summary.changes).toBe(1);
    expect((await gitStatus(opts, ctx)).files.map((f) => f.path)).toEqual(["c.txt"]);
    expect((await gitDiff(opts, { ...ctx, ref: first.commit })).diff).toContain("+three");

    const listed = await gitBranch(opts, ctx);
    expect(listed).toEqual({ current: "main", branches: ["main"] });
    const created = await gitBranch(opts, { ...ctx, name: "feature", create: true });
    expect(created).toEqual({ current: "feature", branches: ["feature", "main"], created: true });
    expect(await gitBranch(opts, { ...ctx, name: "main" })).toEqual({
      current: "main",
      branches: ["feature", "main"],
    });
    await expect(gitBranch(opts, { ...ctx, name: "nope" })).rejects.toThrow();
  }, 30_000);

  test("worktrees live beside the project and go away cleanly", async () => {
    const { root, dir } = await project();
    const opts = { root, policy: runnerPolicy() };
    writeFileSync(join(dir, "a.txt"), "one\n");
    await gitCommit(opts, { ...ctx, message: "first", author });
    const created = await worktreeCreate(opts, { ...ctx, branch: "perch/task-1" });
    expect(created.branch).toBe("perch/task-1");
    expect(created.path).toBe(join(`${dir}.worktrees`, "perch-task-1"));
    expect(existsSync(join(created.path, "a.txt"))).toBe(true);
    expect(git(created.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("perch/task-1");
    expect((await gitBranch(opts, ctx)).branches).toContain("perch/task-1");
    expect(await worktreeRemove(opts, { ...ctx, branch: "perch/task-1" })).toEqual({
      removed: true,
    });
    expect(existsSync(created.path)).toBe(false);
    expect(await worktreeRemove(opts, { ...ctx, branch: "perch/task-1" })).toEqual({
      removed: false,
    });
    // An existing branch gets a worktree without -b.
    const again = await worktreeCreate(opts, { ...ctx, branch: "perch/task-1" });
    expect(existsSync(again.path)).toBe(true);
  }, 30_000);

  test("push sets the upstream on origin; protected branches are refused before any push", async () => {
    const { root, dir } = await project();
    const remote = join(mkdtempSync(join(tmpdir(), "perch-remote-")), "origin.git");
    dirs.push(join(remote, ".."));
    git(root, "init", "--bare", remote);
    git(dir, "remote", "add", "origin", remote);
    writeFileSync(join(dir, "a.txt"), "one\n");
    const opts = { root, policy: runnerPolicy() };
    await gitCommit(opts, { ...ctx, message: "first", author });

    const pushed = await gitPush(opts, ctx);
    expect(pushed).toMatchObject({ pushed: true, remote: "origin", branch: "main" });
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(git(dir, "rev-parse", "HEAD"));
    expect(await gitStatus(opts, ctx)).toMatchObject({ tracking: "origin/main", ahead: 0 });

    const guarded = { root, policy: runnerPolicy({ protectedBranches: ["main"] }) };
    await expect(gitPush(guarded, ctx)).rejects.toThrow(PolicyDenied);
    await gitBranch(opts, { ...ctx, name: "feature", create: true });
    writeFileSync(join(dir, "b.txt"), "two\n");
    await gitCommit(opts, { ...ctx, message: "second", author });
    expect(await gitPush(guarded, { ...ctx, branch: "feature" })).toMatchObject({
      branch: "feature",
    });
    expect(git(remote, "rev-parse", "refs/heads/feature")).toBe(git(dir, "rev-parse", "HEAD"));
  }, 30_000);
});

/**
 * Task 3.15's merge, and the thing CI caught that a developer's machine cannot: a rebase writes
 * commits, and a runner is a fresh container with no `user.email` in it. The first branch to land
 * hides this — its rebase is a no-op because the base has not moved — so the bug only appears on
 * the *second* branch, which is exactly what happened on run 35084505896.
 *
 * An empty `user.name` in the repository's own config is how this is made local and hermetic: git
 * refuses to write a commit with an empty ident, and nothing but `GIT_AUTHOR_*` in the environment
 * can override it — which is precisely what the fix supplies and what a bare container lacks.
 */
describe("landing a branch (task 3.15)", () => {
  async function repoWithTwoBranches() {
    const { root, dir } = await project();
    const opts = { root, policy: runnerPolicy() };
    writeFileSync(join(dir, "base.txt"), "base\n");
    await gitCommit(opts, { ...ctx, message: "first", author });

    for (const [branch, file] of [
      ["perch/one", "one.txt"],
      ["perch/two", "two.txt"],
    ] as const) {
      const made = await worktreeCreate(opts, { ...ctx, branch, base: "main" });
      writeFileSync(join(made.path, file), "hello\n");
      git(made.path, "add", ".");
      git(
        made.path,
        "-c",
        `user.name=${author.name}`,
        "-c",
        `user.email=${author.email}`,
        "commit",
        "-m",
        file,
      );
    }
    return { root, dir, opts };
  }

  test("two branches land in turn: the second rebases onto the first", async () => {
    const { dir, opts } = await repoWithTwoBranches();
    // The repository has no identity to commit with, the way a bare container has none.
    git(dir, "config", "user.name", "");
    git(dir, "config", "user.email", "");

    const first = await gitMerge(opts, { ...ctx, branch: "perch/one", into: "main" });
    expect(first).toMatchObject({ merged: true });
    // The one that has to replay a commit, which is where a missing identity bites.
    const second = await gitMerge(opts, { ...ctx, branch: "perch/two", into: "main" });
    expect(second.reason ?? "").not.toContain("empty ident");
    expect(second).toMatchObject({ merged: true });

    const files = git(dir, "ls-tree", "--name-only", "HEAD").split("\n");
    expect(files).toContain("one.txt");
    expect(files).toContain("two.txt");
  });

  test("a branch that cannot be replayed is a conflict, and main is left alone", async () => {
    const { root, dir } = await project();
    const opts = { root, policy: runnerPolicy() };
    writeFileSync(join(dir, "same.txt"), "base\n");
    await gitCommit(opts, { ...ctx, message: "first", author });
    for (const [branch, body] of [
      ["perch/left", "left\n"],
      ["perch/right", "right\n"],
    ] as const) {
      const made = await worktreeCreate(opts, { ...ctx, branch, base: "main" });
      writeFileSync(join(made.path, "same.txt"), body);
      git(made.path, "add", ".");
      git(
        made.path,
        "-c",
        `user.name=${author.name}`,
        "-c",
        `user.email=${author.email}`,
        "commit",
        "-m",
        branch,
      );
    }
    expect(await gitMerge(opts, { ...ctx, branch: "perch/left", into: "main" })).toMatchObject({
      merged: true,
    });
    const refused = await gitMerge(opts, { ...ctx, branch: "perch/right", into: "main" });
    expect(refused).toMatchObject({ merged: false, conflict: true });
    // Nothing half-applied: the rebase was aborted and main is where it was.
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});
