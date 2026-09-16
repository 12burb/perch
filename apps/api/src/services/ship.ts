/**
 * Shipping a change (spec §5.1 "git panel: … Open PR", §10's Phase 3 exit "`@dawn fix X` from chat
 * ships a diff card and a PR"; task 3.7).
 *
 * The Git panel does this in four presses — branch, commit, push, Open PR — and each one is its own
 * endpoint, because a person wants to stop between them. An agent bot has nobody to press anything,
 * so the same four steps run here in one go.
 *
 * The gates are the same gates. Nothing is committed before it has been read for secrets (task
 * 2.12): history is the one place a key cannot be taken back out of, and an agent writing the file
 * is no reason to skip the check. A push is checked against the workspace's policy (task 2.11)
 * exactly as a person's would be. The push credential is minted for that one push and never
 * reaches the runner's disk or a log line (AGENTS.md §1.6).
 */
import type { Db, Project } from "@perch/db";
import {
  fsReadResultSchema,
  gitBranchResultSchema,
  gitCommitResultSchema,
  gitDiffResultSchema,
  gitPushResultSchema,
  gitStatusResultSchema,
  type RunnerLink,
} from "@perch/events";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import type { ConnectionsService } from "./connections.ts";
import type { PolicyService } from "./policy.ts";
import { openPullRequest, type PullRequest } from "./pull-requests.ts";
import { runnerCall } from "./runners.ts";

export type ShipDeps = {
  db: Db;
  policy: Pick<PolicyService, "secretsIn" | "violated" | "enforce">;
  connections: Pick<ConnectionsService, "connectionFor" | "tokenFor">;
  log: Logger;
};

export type ShipInput = {
  project: Project;
  link: RunnerLink;
  /** Whose runner it is and who the commit is by. */
  userId: string;
  author: { name: string; email: string };
  /** The branch to put the work on; it is created when it is not there. */
  branch: string;
  message: string;
  /** Without one, the work is committed on its branch and left for somebody to push. */
  connectionId?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  by: ActorContext;
};

export type Shipped = {
  /** How many files the session left changed. Zero means there was nothing to ship. */
  changed: number;
  branch: string;
  commit: string | null;
  pushed: boolean;
  pullRequest: PullRequest | null;
  /** Why it stopped where it did, when it stopped short of a pull request. */
  note: string | null;
};

/** The push credential, minted for this one push (ADR-0070). */
async function pushCredential(
  deps: ShipDeps,
  workspaceId: string,
  userId: string,
  connectionId: string | undefined,
): Promise<{ kind: "token"; token: string; username?: string } | null> {
  if (!connectionId) return null;
  const connection = await deps.connections.connectionFor(workspaceId, userId, connectionId);
  if (!connection) throw PerchError.notFound("connection");
  const token = await deps.connections.tokenFor(connection);
  return { kind: "token", token, username: "x-access-token" };
}

/** A branch name a git will take: what somebody asked, with everything else turned into a dash. */
export function branchName(prefix: string, said: string): string {
  const slug = said
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${prefix}/${slug || "change"}`;
}

/**
 * Branch, scan, commit, push, open the pull request — stopping at the first step that has nothing
 * to do, and saying which one that was. A project with no repository or no connection still gets
 * its commit; what it does not get is a link, and the card says so rather than pretending.
 */
export async function ship(deps: ShipDeps, input: ShipInput): Promise<Shipped> {
  const base = {
    workspace_id: input.project.workspaceId,
    user_id: input.userId,
    project: input.project.id,
  };
  const status = gitStatusResultSchema.parse(await runnerCall(input.link, "git.status", base));
  const out: Shipped = {
    changed: status.files.length,
    branch: status.branch ?? input.branch,
    commit: null,
    pushed: false,
    pullRequest: null,
    note: null,
  };
  if (status.files.length === 0) return { ...out, note: "nothing changed" };

  // A branch of its own, so nobody's default branch grows a commit they did not ask for.
  const branched = gitBranchResultSchema.parse(
    await runnerCall(input.link, "git.branch", { ...base, name: input.branch, create: true }),
  );
  out.branch = branched.current ?? input.branch;

  // Task 2.12: the last gate before a key reaches history.
  const change = await wholeChange(input.link, {
    ws: input.project.workspaceId,
    userId: input.userId,
    projectId: input.project.id,
  });
  const found = await deps.policy.secretsIn(
    { workspaceId: input.project.workspaceId, project: input.project },
    change,
  );
  if (found.length > 0) {
    await deps.policy.violated(
      {
        workspaceId: input.project.workspaceId,
        project: input.project,
        subject: { type: "user", id: input.userId },
      },
      { kind: "fs.write", path: found[0]?.path ?? "" },
      { allow: false, rule: "secrets.scan", reason: `${found.length} found` },
      input.by,
    );
    return {
      ...out,
      note:
        found.length === 1
          ? `${found[0]?.name} is in ${found[0]?.path}, so nothing was committed`
          : `${found.length} things that look like credentials are in this change, so nothing was committed`,
    };
  }

  const committed = gitCommitResultSchema.parse(
    await runnerCall(input.link, "git.commit", {
      ...base,
      message: input.message,
      author: input.author,
    }),
  );
  out.commit = committed.commit;
  if (!input.connectionId)
    return { ...out, note: "committed on its branch; no connection to push with" };
  if (!input.project.repoUrl) {
    return { ...out, note: "committed on its branch; this project has no repository" };
  }

  await deps.policy.enforce(
    { workspaceId: input.project.workspaceId, project: input.project },
    { kind: "git.push", branch: out.branch },
    input.by,
  );
  const auth = await pushCredential(
    deps,
    input.project.workspaceId,
    input.userId,
    input.connectionId,
  );
  const pushed = gitPushResultSchema.parse(
    await runnerCall(input.link, "git.push", {
      ...base,
      branch: out.branch,
      ...(auth ? { auth } : {}),
    }),
  );
  out.pushed = true;
  out.branch = pushed.branch;

  try {
    out.pullRequest = await openPullRequest(
      { connections: deps.connections as ConnectionsService },
      {
        project: input.project,
        link: input.link,
        userId: input.userId,
        connectionId: input.connectionId,
        title: input.title ?? input.message.split("\n")[0] ?? "A change from Perch",
        ...(input.body ? { body: input.body } : {}),
        head: out.branch,
      },
    );
    return out;
  } catch (error) {
    // The work is pushed either way; a provider that would not open the PR is worth saying, not
    // worth losing the branch over.
    const said = error instanceof Error ? error.message : String(error);
    deps.log.warn({ err: error, projectId: input.project.id }, "a shipped branch got no PR");
    return { ...out, note: `pushed, but the pull request did not open: ${said}` };
  }
}

/** A file big enough that reading it to look for a key is not worth the wait. */
const SCAN_MAX_BYTES = 512 * 1024;
/** How many new files one commit may bring before the scan stops reading them one by one. */
const SCAN_MAX_FILES = 200;

/**
 * Everything a commit is about to take, as one diff to read (task 2.12). `git diff` knows about
 * files git already knows about; a file the agent has just written is untracked, so its content is
 * added as if the whole thing were new — which, to history, it is.
 */
export async function wholeChange(
  link: RunnerLink,
  input: { ws: string; userId: string; projectId: string; paths?: readonly string[] | undefined },
): Promise<string> {
  const base = { workspace_id: input.ws, user_id: input.userId, project: input.projectId };
  const tracked = gitDiffResultSchema.parse(await runnerCall(link, "git.diff", base));
  const status = gitStatusResultSchema.parse(await runnerCall(link, "git.status", base));
  const wanted = input.paths && input.paths.length > 0 ? new Set(input.paths) : null;
  const fresh = status.files
    .filter((file) => file.index === "?" && (!wanted || wanted.has(file.path)))
    .slice(0, SCAN_MAX_FILES);
  const parts = [tracked.diff];
  for (const file of fresh) {
    try {
      const read = fsReadResultSchema.parse(
        await runnerCall(link, "fs.read", { ...base, path: file.path }),
      );
      // A binary file has nothing to read, and a huge one is not worth the wait.
      if (read.encoding !== "utf8" || read.size > SCAN_MAX_BYTES) continue;
      const body = read.content
        .split(/\r?\n/)
        .map((line) => `+${line}`)
        .join("\n");
      parts.push(`diff --git a/${file.path} b/${file.path}\n+++ b/${file.path}\n@@\n${body}`);
    } catch {
      // A file that cannot be read is one the commit will not take either.
    }
  }
  return parts.join("\n");
}
