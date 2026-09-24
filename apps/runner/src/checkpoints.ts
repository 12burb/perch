/**
 * Checkpoints (task 1.13; spec §7.6 session.checkpoint / session.restore, §6 session_checkpoints):
 * a snapshot of the project's working tree — tracked and untracked files, ignores honored, never
 * `.git` — as a commit under `refs/perch/checkpoints/<session>/<turn>`. The same snapshot gives a
 * diff of the working tree against any ref (new files included), a restore back to a checkpoint,
 * and `git apply` of a patch forward or in reverse. Every path a restore or an apply touches goes
 * through the policy's fs.write rules first.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type FileDiff,
  JSON_RPC_ERRORS,
  type RunnerRequestParams,
  RunnerRpcError,
  splitPatches,
} from "@perch/events";
import type { GitOptions } from "./git.ts";
import { asUserFs, type RunAs, userTempDir } from "./identity.ts";
import { enforce } from "./policy.ts";
import { cloneEnv, projectDir, runGit } from "./projects.ts";

const REF_BASE = "refs/perch/checkpoints";
const PERCH_IDENTITY = {
  GIT_AUTHOR_NAME: "Perch",
  GIT_AUTHOR_EMAIL: "noreply@perch.local",
  GIT_COMMITTER_NAME: "Perch",
  GIT_COMMITTER_EMAIL: "noreply@perch.local",
};

/** Where a session's checkpoint for a turn lives in the project's repository. */
export function checkpointRef(sessionId: string, turn: number): string {
  return `${REF_BASE}/${sessionId}/${turn}`;
}

/** The project's directory, which must be a repository. */
export function repoDir(root: string, params: { workspace_id: string; project: string }): string {
  const dir = projectDir(root, params.workspace_id, params.project);
  if (!existsSync(join(dir, ".git"))) {
    throw new RunnerRpcError(
      JSON_RPC_ERRORS.invalidParams,
      "project is not a git repository on this runner",
    );
  }
  return dir;
}

/**
 * The settings every snapshot command runs under. Line-ending conversion is off: a checkpoint is
 * the bytes that were in the working tree and a restore puts those bytes back. Git for Windows
 * turns `core.autocrlf` on by default, which would rewrite every LF file as CRLF on the way back
 * out — a whole-file change nobody asked for. A project's own `.gitattributes` still applies, as
 * it would to any other git command.
 */
const PLUMBING = [
  "-c",
  "core.quotePath=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
  "-c",
  "core.safecrlf=false",
];

/** A scratch directory of `user`'s, removed with their credentials, never root's (ADR-0171). */
function removeScratch(user: RunAs, dir: string): void {
  asUserFs(user, () => rmSync(dir, { recursive: true, force: true }));
}

/** Plumbing, as the member who asked (ADR-0171). */
function git(
  dir: string,
  user: RunAs,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  return runGit([...PLUMBING, ...args], {
    cwd: dir,
    env: cloneEnv(process.env, env),
    timeoutMs: 120_000,
    user,
  });
}

/**
 * The working tree as a tree object: everything `git add -A` would stage, into a scratch index the
 * member's git can write.
 */
export async function snapshotTree(dir: string, user: RunAs = null): Promise<string> {
  const scratch = userTempDir(user, "perch-index-");
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  try {
    await git(dir, user, ["add", "-A", "--", "."], env);
    return (await git(dir, user, ["write-tree"], env)).trim();
  } finally {
    removeScratch(user, scratch);
  }
}

/** `session.checkpoint`: the tree before a turn, as a parentless commit on the checkpoint ref. */
export async function checkpoint(
  options: GitOptions,
  params: RunnerRequestParams<"session.checkpoint">,
): Promise<{ git_ref: string }> {
  const dir = repoDir(options.root, params);
  const user = params.user_id;
  const tree = await snapshotTree(dir, user);
  const message = `perch checkpoint ${params.session_id} turn ${params.turn}`;
  const commit = (
    await git(dir, user, ["commit-tree", tree, "-m", message], PERCH_IDENTITY)
  ).trim();
  await git(dir, user, ["update-ref", checkpointRef(params.session_id, params.turn), commit]);
  return { git_ref: commit };
}

/**
 * The checkpoint's commit: the one the api names (a fork's checkpoints were taken under the
 * session it copied, so its ref carries the other session's name), else this session's own ref.
 */
async function resolveCheckpoint(
  dir: string,
  user: RunAs,
  sessionId: string,
  turn: number,
  gitRef?: string,
): Promise<string> {
  for (const candidate of [...(gitRef ? [gitRef] : []), checkpointRef(sessionId, turn)]) {
    try {
      const sha = await git(dir, user, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${candidate}^{commit}`,
      ]);
      if (sha.trim()) return sha.trim();
    } catch {
      // not here: try the next candidate
    }
  }
  throw new RunnerRpcError(JSON_RPC_ERRORS.invalidParams, `no checkpoint for turn ${turn}`);
}

/** `git diff --name-status -z` between two tree-ish objects, as [status, path] pairs. */
async function changedPaths(
  dir: string,
  user: RunAs,
  from: string,
  to: string,
): Promise<[string, string][]> {
  const raw = await git(dir, user, ["diff", "--name-status", "--no-renames", "-z", from, to]);
  const parts = raw.split("\0").filter((part) => part.length > 0);
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    out.push([(parts[i] ?? "").charAt(0), parts[i + 1] ?? ""]);
  }
  return out;
}

/**
 * `session.restore`: the working tree goes back to the checkpoint. Files that differ are written
 * from the checkpoint's tree; files that did not exist then are removed. Nothing else (ignored
 * files, the index, HEAD, branches) is touched.
 */
export async function restore(
  options: GitOptions,
  params: RunnerRequestParams<"session.restore">,
): Promise<{ git_ref: string; files: string[] }> {
  const dir = repoDir(options.root, params);
  const user = params.user_id;
  const commit = await resolveCheckpoint(dir, user, params.session_id, params.turn, params.git_ref);
  const now = await snapshotTree(dir, user);
  const changes = await changedPaths(dir, user, commit, now);
  if (changes.length === 0) return { git_ref: commit, files: [] };
  for (const [, path] of changes) {
    enforce(options.policy, { kind: "fs.write", project: params.project, path });
  }
  const removed = changes.filter(([status]) => status === "A").map(([, path]) => path);
  const recreated = changes.filter(([status]) => status === "D").map(([, path]) => path);
  const rewritten = changes
    .filter(([status]) => status !== "A" && status !== "D")
    .map(([, path]) => path);
  const scratch = userTempDir(user, "perch-index-");
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  try {
    await git(dir, user, ["read-tree", commit], env);
    const toWrite = [...recreated, ...rewritten];
    for (let i = 0; i < toWrite.length; i += 200) {
      await git(dir, user, ["checkout-index", "-f", "--", ...toWrite.slice(i, i + 200)], env);
    }
  } finally {
    removeScratch(user, scratch);
  }
  // Removed as the member: a path under a directory someone swapped for a link is theirs to fail on.
  asUserFs(user, () => {
    for (const path of removed) rmSync(join(dir, path), { force: true });
  });
  for (const [paths, kind] of [
    [rewritten, "change"],
    [recreated, "create"],
    [removed, "delete"],
  ] as const) {
    if (paths.length > 0) {
      options.notify?.({ method: "fs.changed", params: { project: params.project, paths, kind } });
    }
  }
  return { git_ref: commit, files: changes.map(([, path]) => path) };
}

/**
 * A diff from a ref to another ref, or to the working tree as it is now (untracked files included,
 * ignores honored): the unified text, a per-file summary, and one FileDiff per file.
 */
export async function diffRange(
  options: Pick<GitOptions, "root">,
  params: { workspace_id: string; user_id: string; project: string; from: string; to?: string },
): Promise<{
  diff: string;
  files: { path: string; additions: number; deletions: number; binary: boolean }[];
  patches: FileDiff[];
}> {
  const dir = repoDir(options.root, params);
  const to = params.to ?? (await snapshotTree(dir, params.user_id));
  const diff = await git(dir, params.user_id, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    // What follows are revisions: a caller's `--output=…` is a bad revision, not a file written.
    "--end-of-options",
    params.from,
    to,
  ]);
  const text = diff.length > 0 ? `${diff}\n` : "";
  const patches = splitPatches(text);
  return {
    diff: text,
    files: patches.map((patch) => ({
      path: patch.path,
      additions: patch.additions,
      deletions: patch.deletions,
      binary: /\nBinary files .* differ\n?$/.test(patch.patch),
    })),
    patches,
  };
}

/** `git.apply`: a unified patch applied to the working tree (`--reverse` undoes it). */
export async function gitApply(
  options: GitOptions,
  params: RunnerRequestParams<"git.apply">,
): Promise<{ files: string[] }> {
  const dir = repoDir(options.root, params);
  const files = splitPatches(params.patch);
  const paths = [...new Set(files.flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]))];
  if (paths.length === 0) {
    throw new RunnerRpcError(JSON_RPC_ERRORS.invalidParams, "the patch names no files");
  }
  for (const path of paths) {
    enforce(options.policy, { kind: "fs.write", project: params.project, path });
  }
  const scratch = userTempDir(params.user_id, "perch-patch-", {
    "changes.patch": { content: params.patch, mode: 0o600 },
  });
  const file = join(scratch, "changes.patch");
  try {
    await git(dir, params.user_id, [
      "apply",
      ...(params.reverse ? ["--reverse"] : []),
      "--whitespace=nowarn",
      file,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RunnerRpcError(JSON_RPC_ERRORS.invalidParams, `the patch does not apply: ${message}`);
  } finally {
    removeScratch(params.user_id, scratch);
  }
  options.notify?.({
    method: "fs.changed",
    params: { project: params.project, paths, kind: "change" },
  });
  return { files: paths };
}
