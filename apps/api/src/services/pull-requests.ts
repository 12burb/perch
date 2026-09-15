/**
 * Opening a pull request through a connection (task 1.16 acceptance: "clone via GitHub connection
 * → PR opened"; spec §5.5 "Open PR from diff card").
 *
 * Two steps, both on the connection's token and neither storing it: the branch is pushed through
 * the runner, then the provider is asked to open the PR. The token is minted for this one round
 * and never reaches the runner's disk, a transcript, or a log line (AGENTS.md §1.6).
 */
import { apiBaseOf, type FetchLike } from "@perch/connect";
import type { Project } from "@perch/db";
import type { RunnerLink } from "@perch/events";
import { PerchError } from "../errors.ts";
import type { ConnectionsService } from "./connections.ts";
import { runnerCall } from "./runners.ts";

export type OpenPullRequestInput = {
  project: Project;
  link: RunnerLink;
  userId: string;
  connectionId: string;
  title: string;
  body?: string;
  /** The branch to open from; the project's current branch when it is not said. */
  head?: string;
  /** What to merge into; the project's default branch when it is not said. */
  base?: string;
};

export type PullRequest = { number: number; url: string; branch: string };

/** owner/repo out of any URL git would clone: https, ssh, or scp-like. */
export function repoSlug(repoUrl: string): { owner: string; repo: string } | null {
  const trimmed = repoUrl.trim().replace(/\.git$/, "");
  const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?<path>[^\s]+)$/.exec(trimmed);
  const path = scp?.groups?.path ?? safePath(trimmed);
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  const repo = parts.pop();
  const owner = parts.pop();
  return owner && repo ? { owner, repo } : null;
}

function safePath(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

export async function openPullRequest(
  deps: { connections: ConnectionsService; fetch?: FetchLike },
  input: OpenPullRequestInput,
): Promise<PullRequest> {
  const { project } = input;
  if (!project.repoUrl) {
    throw PerchError.validation("this project has no repository to open a pull request against");
  }
  const slug = repoSlug(project.repoUrl);
  if (!slug) {
    throw PerchError.validation("this project's repository URL has no owner and name", {
      repo_url: project.repoUrl,
    });
  }
  const connection = await deps.connections.connectionFor(
    project.workspaceId,
    input.userId,
    input.connectionId,
  );
  if (!connection) throw PerchError.notFound("connection");
  const manifest = deps.connections.manifest(connection.provider);
  const token = await deps.connections.tokenFor(connection);

  // Push first: a pull request for a branch the remote has never seen is not a pull request.
  const pushed = (await runnerCall(input.link, "git.push", {
    workspace_id: project.workspaceId,
    user_id: input.userId,
    project: project.id,
    ...(input.head ? { branch: input.head } : {}),
    auth: { kind: "token", token, username: "x-access-token" },
  })) as { branch?: string };
  const head = input.head ?? pushed.branch;
  if (!head) throw PerchError.validation("there is no branch to open a pull request from");

  const base = apiBaseOf(manifest, connection.metadata.apiBase);
  const call: FetchLike = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await call(`${base}/repos/${slug.owner}/${slug.repo}/pulls`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "perch",
      },
      body: JSON.stringify({
        title: input.title,
        head,
        base: input.base ?? project.defaultBranch,
        ...(input.body ? { body: input.body } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    // Never repeat the request: it carried the token.
    throw new PerchError(
      "upstream_failed",
      `could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      502,
    );
  }
  const answer = (await response.json().catch(() => null)) as {
    number?: unknown;
    html_url?: unknown;
    message?: unknown;
    errors?: unknown;
  } | null;
  if (!response.ok) {
    // The provider's own reason is the useful part; it never contains the token.
    const reason = typeof answer?.message === "string" ? answer.message : response.statusText;
    throw new PerchError("upstream_failed", `${manifest.name} refused: ${reason}`, undefined, 502);
  }
  if (typeof answer?.number !== "number" || typeof answer.html_url !== "string") {
    throw new PerchError(
      "upstream_failed",
      `${manifest.name} did not answer with a pull request`,
      undefined,
      502,
    );
  }
  return { number: answer.number, url: answer.html_url, branch: head };
}
