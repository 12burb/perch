/**
 * git.* and worktree.* on a runner (spec §7.6, task 1.5): status, diff, commit, push, branch, and
 * worktrees for a project, through simple-git for reads and commits and a direct `git` spawn for
 * pushes (credentials the same way a clone gets them: helper or key file, never argv). Every write
 * goes through the policy hook.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BRANCH_NAME, type RunnerRequestParams, splitPatches } from "@perch/events";
import { type SimpleGit, simpleGit } from "simple-git";
import { diffRange } from "./checkpoints.ts";
import { asUserFs, asUserGit, CREDENTIALED_GIT, type RunAs, userTempDir } from "./identity.ts";
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

/** simple-git in a directory, as the member who asked (ADR-0171). */
function gitAt(dir: string, user: RunAs, env: Record<string, string> = {}): SimpleGit {
  const run = asUserGit(user, cloneEnv(process.env, env));
  return simpleGit({ baseDir: dir, ...run.options }).env(run.env);
}

/**
 * Who a commit is by, as environment rather than as config. A runner is a fresh container with no
 * `user.email` in it, so anything that writes a commit has to carry an identity or git refuses —
 * and a rebase writes commits too, which is what task 3.15 learned the hard way.
 */
function identity(author?: { name: string; email: string }): Record<string, string> {
  const who = author ?? {
    name: process.env.GIT_AUTHOR_NAME ?? "Perch",
    email: process.env.GIT_AUTHOR_EMAIL ?? "noreply@perch.local",
  };
  return {
    GIT_AUTHOR_NAME: who.name,
    GIT_AUTHOR_EMAIL: who.email,
    GIT_COMMITTER_NAME: who.name,
    GIT_COMMITTER_EMAIL: who.email,
  };
}

export async function gitStatus(options: GitOptions, params: RunnerRequestParams<"git.status">) {
  const status = await gitAt(dirOf(options, params), params.user_id).status();
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
      user_id: params.user_id,
      from: params.ref,
      ...(params.to ? { to: params.to } : {}),
    });
  }
  const git = gitAt(dirOf(options, params), params.user_id);
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

/** The protocol's rule for a branch name (ADR-0164), applied again where argv is built. */
export function assertBranchName(name: string): void {
  if (!BRANCH_NAME.test(name)) throw new Error(`not a branch name: ${name}`);
}

export async function gitCommit(options: GitOptions, params: RunnerRequestParams<"git.commit">) {
  const dir = dirOf(options, params);
  enforce(options.policy, {
    kind: "git.commit",
    project: params.project,
    paths: params.paths ?? [],
  });
  const git = gitAt(dir, params.user_id, identity(params.author ?? undefined));
  // `--` first: a path is a path, never an option (`--force` would stage what .gitignore hides,
  // past the secrets scan that only sees what git status shows; ADR-0164).
  if (params.paths && params.paths.length > 0) await git.add(["--", ...params.paths]);
  else await git.add(["-A", "--", "."]);
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
  const git = gitAt(dir, params.user_id);
  const branch = params.branch ?? (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  if (!branch || branch === "HEAD") throw new Error("no branch to push (detached HEAD)");
  // A branch name, not a refspec and not an option: `+HEAD:refs/heads/main` or `--force` would
  // be a force push nothing above could see (ADR-0164).
  assertBranchName(branch);
  enforce(options.policy, { kind: "git.push", project: params.project, branch });
  let keyDir: string | null = null;
  // A push that holds a credential runs as the account nothing else runs as: git's environment and
  // the key file are readable by every process of the uid git runs as (ADR-0171).
  const who: RunAs = params.auth ? CREDENTIALED_GIT : params.user_id;
  try {
    let keyFile: string | undefined;
    if (params.auth?.kind === "ssh") {
      const key = params.auth.privateKey;
      keyDir = userTempDir(who, "perch-key-", {
        id: { content: key.endsWith("\n") ? key : `${key}\n`, mode: 0o600 },
      });
      keyFile = join(keyDir, "id");
    }
    const auth = gitAuth(params.auth, keyFile);
    const output = await runGit(
      [
        ...auth.config.flatMap((entry) => ["-c", entry]),
        "push",
        "--set-upstream",
        "--end-of-options",
        "origin",
        `refs/heads/${branch}:refs/heads/${branch}`,
      ],
      {
        cwd: dir,
        env: cloneEnv(process.env, auth.env),
        timeoutMs: options.pushTimeoutMs ?? 600_000,
        user: who,
      },
    );
    return { pushed: true as const, remote: "origin", branch, output };
  } finally {
    const scratch = keyDir;
    if (scratch) asUserFs(who, () => rmSync(scratch, { recursive: true, force: true }));
  }
}

export async function gitBranch(options: GitOptions, params: RunnerRequestParams<"git.branch">) {
  const dir = dirOf(options, params);
  const git = gitAt(dir, params.user_id);
  if (params.name) {
    // A name, never an option: `git checkout -f` resets the working tree (ADR-0164).
    assertBranchName(params.name);
    enforce(options.policy, { kind: "git.branch", project: params.project, branch: params.name });
    // A validated name cannot begin with a dash, so it is a name to git here too (checkout has no
    // `--end-of-options` in the git versions runners carry; `--` would make it a pathspec).
    if (params.create) await git.raw(["checkout", "-b", params.name]);
    else await git.raw(["checkout", params.name]);
  }
  const summary = await git.branchLocal();
  return {
    current: summary.detached ? null : summary.current || null,
    branches: summary.all,
    ...(params.name && params.create ? { created: true } : {}),
  };
}

/**
 * Where a branch's worktree lives: one directory beside the project, named for the branch with
 * everything a path could trip over flattened out. `perch/aviary-4/acp-fake` is a fine branch and
 * a bad directory name — so this is the one place that turns one into the other, and everything
 * that needs the directory (the runner's sessions among them) asks here rather than joining a
 * branch onto a path itself.
 */
export function worktreePath(
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
  assertBranchName(params.branch);
  const dir = dirOf(options, params);
  enforce(options.policy, {
    kind: "worktree.create",
    project: params.project,
    branch: params.branch,
  });
  const git = gitAt(dir, params.user_id);
  const path = worktreePath(options.root, params.workspace_id, params.project, params.branch);
  // Asking twice is asking where it is (task 3.15): the merge queue needs the directory a branch
  // is checked out in, and making a second one for the same branch is what git would refuse.
  if (existsSync(path)) return { path, branch: params.branch };
  const existing = (await git.branchLocal()).all.includes(params.branch);
  const args = existing
    ? ["worktree", "add", "--end-of-options", path, params.branch]
    : [
        "worktree",
        "add",
        "-b",
        params.branch,
        "--end-of-options",
        path,
        ...(params.base ? [params.base] : []),
      ];
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
    await gitAt(dir, params.user_id).raw(["worktree", "remove", "--force", path]);
  } catch {
    rmSync(path, { recursive: true, force: true });
    await gitAt(dir, params.user_id).raw(["worktree", "prune"]);
  }
  return { removed: true };
}

/** The directory a branch is checked out in, when one of this project's worktrees has it. */
async function worktreeFor(git: SimpleGit, branch: string): Promise<string | null> {
  const raw = await git.raw(["worktree", "list", "--porcelain"]);
  let path: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    if (line.trim() === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

/**
 * Land a branch on another one (spec §5.7 "merge queue with rebase, conflict detection"; task
 * 3.15, ADR-0131).
 *
 * Rebase then fast-forward, both here, because a queue landing two branches has to do this as one
 * operation or the second one is racing the first. The rebase runs in the branch's own worktree
 * when it has one — git will not rebase a branch that is checked out somewhere else, and after
 * task 3.14 it usually is.
 *
 * A conflict is not an error: it is the answer, and the queue turns it into something the agent is
 * asked to fix.
 */
export async function gitMerge(options: GitOptions, params: RunnerRequestParams<"git.merge">) {
  const dir = dirOf(options, params);
  const git = gitAt(dir, params.user_id, identity());
  enforce(options.policy, { kind: "git.branch", project: params.project, branch: params.branch });
  const into = params.into ?? (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  if (params.branch === into) return { merged: false, reason: "a branch cannot land on itself" };

  if (params.rebase !== false) {
    const where = (await worktreeFor(git, params.branch)) ?? dir;
    const rebase = gitAt(where, params.user_id, identity());
    const onSpot = where === dir;
    try {
      // In the project directory the branch is not checked out, so say which one to rebase.
      await rebase.raw(onSpot ? ["rebase", into, params.branch] : ["rebase", into]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await rebase.raw(["rebase", "--abort"]).catch(() => undefined);
      // Put the project directory back on `into` if the on-the-spot rebase left it detached.
      if (onSpot) await git.raw(["checkout", into]).catch(() => undefined);
      return { merged: false, conflict: true, reason };
    }
    if (onSpot) await git.raw(["checkout", into]).catch(() => undefined);
  }

  try {
    const head = await git.revparse(["--abbrev-ref", "HEAD"]);
    if (head.trim() !== into) await git.raw(["checkout", into]);
    await git.raw(["merge", "--ff-only", params.branch]);
  } catch (error) {
    return {
      merged: false,
      conflict: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return { merged: true, head: (await git.revparse(["HEAD"])).trim() };
}
