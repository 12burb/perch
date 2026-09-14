/**
 * git.* and worktree.* on a runner (spec §7.6, task 1.5): status, diff, commit, push, branch, and
 * worktrees for a project, through simple-git for reads and commits and a direct `git` spawn for
 * pushes (credentials the same way a clone gets them: helper or key file, never argv). Every write
 * goes through the policy hook.
 */
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunnerRequestParams, splitPatches } from "@perch/events";
import { type SimpleGit, simpleGit } from "simple-git";
import { diffRange } from "./checkpoints.ts";
import type { Notify } from "./notify.ts";
import { enforce, type RunnerPolicy } from "./policy.ts";
import { cloneEnv, gitAuth, projectDir, runGit } from "./projects.ts";

export type GitOptions = {
  root: string;
  policy: RunnerPolicy;
  /** git push budget. */
  pushTimeoutMs?: number;
  /** Where fs.changed goes after a restore or an applied patch (task 1.13). */
  notify?: Notify;
};

function dirOf(options: GitOptions, params: { workspace_id: string; project: string }): string {
  const dir = projectDir(options.root, params.workspace_id, params.project);
  if (!existsSync(join(dir, ".git")))
    throw new Error("project is not a git repository on this runner");
  return dir;
}

function gitAt(dir: string, env: Record<string, string> = {}): SimpleGit {
  return simpleGit({ baseDir: dir }).env(cloneEnv(process.env, env));
}

export async function gitStatus(options: GitOptions, params: RunnerRequestParams<"git.status">) {
  const status = await gitAt(dirOf(options, params)).status();
  return {
    branch: status.current,
    tracking: status.tracking,
    ahead: status.ahead,
    behind: status.behind,
    clean: status.isClean(),
    files: status.files.map((file) => ({
      path: file.path,
      index: file.index,
      workingTree: file.working_dir,
    })),
  };
}

/**
 * Without a ref: the working tree against HEAD, tracked files only (the index on an unborn
 * branch). With `ref`: the working tree as it is now — untracked files included, ignores honored —
 * against that ref; with `to` as well, one ref against another (task 1.13, ADR-0079).
 */
export async function gitDiff(options: GitOptions, params: RunnerRequestParams<"git.diff">) {
  if (params.ref) {
    return diffRange(options, {
      workspace_id: params.workspace_id,
      project: params.project,
      from: params.ref,
      ...(params.to ? { to: params.to } : {}),
    });
  }
  const git = gitAt(dirOf(options, params));
  let diff: string;
  let files: { path: string; additions: number; deletions: number; binary: boolean }[];
  try {
    diff = await git.diff(["HEAD"]);
    const summary = await git.diffSummary(["HEAD"]);
    files = summary.files.map((file) => ({
      path: file.file,
      additions: "insertions" in file ? file.insertions : 0,
      deletions: "deletions" in file ? file.deletions : 0,
      binary: file.binary,
    }));
  } catch {
    diff = await git.diff();
    const summary = await git.diffSummary();
    files = summary.files.map((file) => ({
      path: file.file,
      additions: "insertions" in file ? file.insertions : 0,
      deletions: "deletions" in file ? file.deletions : 0,
      binary: file.binary,
    }));
  }
  return { diff, files, patches: splitPatches(diff) };
}

export async function gitCommit(options: GitOptions, params: RunnerRequestParams<"git.commit">) {
  const dir = dirOf(options, params);
  enforce(options.policy, {
    kind: "git.commit",
    project: params.project,
    paths: params.paths ?? [],
  });
  const author = params.author ?? {
    name: process.env.GIT_AUTHOR_NAME ?? "Perch",
    email: process.env.GIT_AUTHOR_EMAIL ?? "noreply@perch.local",
  };
  const git = gitAt(dir, {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  });
  if (params.paths && params.paths.length > 0) await git.add(params.paths);
  else await git.add(["-A", "."]);
  const result = await git.commit(params.message);
  if (!result.commit) throw new Error("nothing to commit");
  return {
    commit: result.commit,
    branch: result.branch,
    summary: {
      changes: result.summary.changes,
      insertions: result.summary.insertions,
      deletions: result.summary.deletions,
    },
  };
}

export async function gitPush(options: GitOptions, params: RunnerRequestParams<"git.push">) {
  const dir = dirOf(options, params);
  const git = gitAt(dir);
  const branch = params.branch ?? (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  if (!branch || branch === "HEAD") throw new Error("no branch to push (detached HEAD)");
  enforce(options.policy, { kind: "git.push", project: params.project, branch });
  let keyDir: string | null = null;
  try {
    let keyFile: string | undefined;
    if (params.auth?.kind === "ssh") {
      keyDir = await mkdtemp(join(tmpdir(), "perch-key-"));
      keyFile = join(keyDir, "id");
      const key = params.auth.privateKey;
      await Bun.write(keyFile, key.endsWith("\n") ? key : `${key}\n`);
      const { chmodSync } = await import("node:fs");
      chmodSync(keyFile, 0o600);
    }
    const auth = gitAuth(params.auth, keyFile);
    const output = await runGit(
      [
        ...auth.config.flatMap((entry) => ["-c", entry]),
        "push",
        "--set-upstream",
        "origin",
        branch,
      ],
      {
        cwd: dir,
        env: cloneEnv(process.env, auth.env),
        timeoutMs: options.pushTimeoutMs ?? 600_000,
      },
    );
    return { pushed: true as const, remote: "origin", branch, output };
  } finally {
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  }
}

export async function gitBranch(options: GitOptions, params: RunnerRequestParams<"git.branch">) {
  const dir = dirOf(options, params);
  const git = gitAt(dir);
  if (params.name) {
    enforce(options.policy, { kind: "git.branch", project: params.project, branch: params.name });
    if (params.create) await git.checkoutLocalBranch(params.name);
    else await git.checkout(params.name);
  }
  const summary = await git.branchLocal();
  return {
    current: summary.detached ? null : summary.current || null,
    branches: summary.all,
    ...(params.name && params.create ? { created: true } : {}),
  };
}

function worktreePath(
  root: string,
  workspaceId: string,
  projectId: string,
  branch: string,
): string {
  const safe = branch.replace(/[^A-Za-z0-9._-]+/g, "-");
  return join(`${projectDir(root, workspaceId, projectId)}.worktrees`, safe);
}

/** A worktree beside the project (`<project>.worktrees/<branch>`), creating the branch from base. */
export async function worktreeCreate(
  options: GitOptions,
  params: RunnerRequestParams<"worktree.create">,
) {
  const dir = dirOf(options, params);
  enforce(options.policy, {
    kind: "worktree.create",
    project: params.project,
    branch: params.branch,
  });
  const git = gitAt(dir);
  const path = worktreePath(options.root, params.workspace_id, params.project, params.branch);
  const existing = (await git.branchLocal()).all.includes(params.branch);
  const args = existing
    ? ["worktree", "add", path, params.branch]
    : ["worktree", "add", "-b", params.branch, path, ...(params.base ? [params.base] : [])];
  await git.raw(args);
  return { path, branch: params.branch };
}

export async function worktreeRemove(
  options: GitOptions,
  params: RunnerRequestParams<"worktree.remove">,
) {
  const dir = dirOf(options, params);
  enforce(options.policy, {
    kind: "worktree.remove",
    project: params.project,
    branch: params.branch,
  });
  const path = worktreePath(options.root, params.workspace_id, params.project, params.branch);
  if (!existsSync(path)) return { removed: false };
  try {
    await gitAt(dir).raw(["worktree", "remove", "--force", path]);
  } catch {
    rmSync(path, { recursive: true, force: true });
    await gitAt(dir).raw(["worktree", "prune"]);
  }
  return { removed: true };
}
