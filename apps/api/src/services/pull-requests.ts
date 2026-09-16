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
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import type { ConnectionsService } from "./connections.ts";
import { runnerCall } from "./runners.ts";
import type { SessionService } from "./sessions.ts";

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

/**
 * The Pull Requests page (spec §5.1 "Pull Requests page in Phase 3 with inline comments, request
 * changes, 'ask the agent to address review'"; task 3.20).
 *
 * Everything here is the connection's: Perch keeps no copy of a pull request, and there is no
 * `pull_requests` table. The provider is the truth about its own reviews, and a cache of them would
 * be a second answer that goes stale the moment somebody comments in the provider's own UI.
 */
export type PullRequestSummary = {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  head: { branch: string; sha: string };
  base: { branch: string };
  author: string;
  updatedAt: string;
};

/** One comment on one line of one file: what a review actually is. */
export type ReviewComment = {
  id: number;
  path: string;
  line: number | null;
  body: string;
  author: string;
  /** The lines it was left against, which is what tells an agent where to look. */
  diffHunk: string | null;
};

export type ReviewSummary = { id: number; author: string; state: string; body: string };
export type CheckRun = { name: string; status: string; conclusion: string | null; url: string };

export type PullRequestDetail = PullRequestSummary & {
  body: string;
  comments: ReviewComment[];
  reviews: ReviewSummary[];
  checks: CheckRun[];
};

/** What a review says, in the provider's own words. */
export type ReviewVerdict = "approve" | "request_changes" | "comment";

export type PullRequestsDeps = {
  connections: ConnectionsService;
  log: Logger;
  sessions: Pick<SessionService, "create" | "sendTurn">;
  fetch?: FetchLike;
};

export type PullRequestWhere = {
  project: Project;
  userId: string;
  connectionId: string;
};

export class PullRequestsService {
  constructor(private readonly deps: PullRequestsDeps) {}

  /**
   * One request to the provider, with the connection's own delegated token. Never retried: it
   * carried a credential, and a retry is a second place for that to go wrong (AGENTS.md §1.6).
   */
  private async ask<T>(
    where: PullRequestWhere,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const slug = repoSlug(where.project.repoUrl ?? "");
    if (!slug) {
      throw PerchError.validation("this project has no repository with an owner and a name");
    }
    const connection = await this.deps.connections.connectionFor(
      where.project.workspaceId,
      where.userId,
      where.connectionId,
    );
    if (!connection) throw PerchError.notFound("connection");
    const manifest = this.deps.connections.manifest(connection.provider);
    const token = await this.deps.connections.tokenFor(connection);
    const base = apiBaseOf(manifest, connection.metadata.apiBase);
    const call: FetchLike = this.deps.fetch ?? fetch;

    let response: Response;
    try {
      response = await call(`${base}/repos/${slug.owner}/${slug.repo}${path}`, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "perch",
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new PerchError(
        "upstream_failed",
        `could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        502,
      );
    }
    const answer = (await response.json().catch(() => null)) as { message?: unknown } | null;
    if (!response.ok) {
      const reason = typeof answer?.message === "string" ? answer.message : response.statusText;
      throw new PerchError(
        "upstream_failed",
        `${manifest.name} refused: ${reason}`,
        undefined,
        502,
      );
    }
    return answer as T;
  }

  /** The open ones, newest first — the list a person scans on a Monday. */
  async list(where: PullRequestWhere): Promise<PullRequestSummary[]> {
    const rows = await this.ask<unknown[]>(where, "/pulls?state=open&per_page=50&sort=updated");
    return (Array.isArray(rows) ? rows : []).map(summaryOf).filter(Boolean) as PullRequestSummary[];
  }

  /**
   * One, with the three things a reviewer's decision is made of: what it changed, what people said
   * about which lines, and what the checks made of it.
   */
  async get(where: PullRequestWhere, number: number): Promise<PullRequestDetail> {
    const raw = await this.ask<Record<string, unknown>>(where, `/pulls/${number}`);
    const summary = summaryOf(raw);
    if (!summary) throw PerchError.notFound("pull request");

    const comments = await this.ask<unknown[]>(where, `/pulls/${number}/comments?per_page=100`);
    const reviews = await this.ask<unknown[]>(where, `/pulls/${number}/reviews?per_page=100`);
    // Checks hang off the head commit rather than the pull request, which is why this is a third
    // call: a pull request whose head moved has different checks from the one you were reading.
    let checks: CheckRun[] = [];
    try {
      const runs = await this.ask<{ check_runs?: unknown[] }>(
        where,
        `/commits/${summary.head.sha}/check-runs`,
      );
      checks = (runs.check_runs ?? []).map(checkOf).filter(Boolean) as CheckRun[];
    } catch (error) {
      // A repository with no checks configured answers this differently on every provider, and a
      // pull request is still readable without them.
      this.deps.log.warn({ err: error, number }, "a pull request's checks did not load");
    }

    return {
      ...summary,
      body: typeof raw.body === "string" ? raw.body : "",
      comments: (Array.isArray(comments) ? comments : [])
        .map(commentOf)
        .filter(Boolean) as ReviewComment[],
      reviews: (Array.isArray(reviews) ? reviews : [])
        .map(reviewOf)
        .filter(Boolean) as ReviewSummary[],
      checks,
    };
  }

  /** Approve it, ask for changes, or just say something. The provider records who said it. */
  async review(
    where: PullRequestWhere,
    number: number,
    input: { verdict: ReviewVerdict; body?: string },
  ): Promise<{ id: number; state: string }> {
    if (input.verdict !== "approve" && !input.body?.trim()) {
      throw PerchError.validation("say why, when you are asking for changes");
    }
    const answer = await this.ask<{ id?: unknown; state?: unknown }>(
      where,
      `/pulls/${number}/reviews`,
      {
        method: "POST",
        body: {
          event: input.verdict.toUpperCase(),
          ...(input.body ? { body: input.body } : {}),
        },
      },
    );
    return {
      id: typeof answer.id === "number" ? answer.id : 0,
      state: typeof answer.state === "string" ? answer.state : input.verdict,
    };
  }

  /**
   * "Ask the agent to address review" (task 3.20's acceptance). A session opens on the pull
   * request's own branch, in a worktree of its own, and the first turn is the review: every
   * comment, with the file and the line it was left on, in the order they were made.
   *
   * The branch has to be on this runner already. A pull request whose branch this checkout has
   * never seen would otherwise get a session working on an empty branch cut from `main`, which
   * looks like it is working and is not.
   */
  async address(
    where: PullRequestWhere,
    number: number,
    input: { link: RunnerLink; by: ActorContext; engine?: string | undefined },
  ): Promise<{ sessionId: string; comments: number; branch: string }> {
    const pr = await this.get(where, number);
    if (pr.comments.length === 0) {
      throw PerchError.validation("there is nothing to address: this review left no comments");
    }
    const branches = (await runnerCall(input.link, "git.branch", {
      workspace_id: where.project.workspaceId,
      user_id: where.userId,
      project: where.project.id,
    })) as { branches?: string[] };
    if (!(branches.branches ?? []).includes(pr.head.branch)) {
      throw PerchError.validation(
        `${pr.head.branch} is not on this runner, so there is nothing here to fix`,
        { branch: pr.head.branch },
      );
    }

    const session = await this.deps.sessions.create({
      project: where.project,
      userId: where.userId,
      by: input.by,
      worktree: pr.head.branch,
      // Nobody is sitting in front of it: it was asked for by a button and reports by finishing.
      unattended: true,
      title: `Address review on #${pr.number}`,
      ...(input.engine ? { engine: input.engine } : {}),
    });
    await this.deps.sessions.sendTurn(
      session,
      where.userId,
      { text: reviewTurn(pr) },
      {
        by: input.by,
      },
    );
    return { sessionId: session.id, comments: pr.comments.length, branch: pr.head.branch };
  }
}

/** The review, as one turn: what was asked, where, and by whom. */
export function reviewTurn(pr: PullRequestDetail): string {
  const said = pr.reviews
    .filter((one) => one.body.trim() && one.state.toUpperCase() !== "APPROVED")
    .map((one) => `${one.author}: ${one.body.trim()}`);
  const lines = [
    `Address the review on pull request #${pr.number} (${pr.title}).`,
    "",
    ...(said.length > 0 ? [...said, ""] : []),
    "The comments, each on the line it was left against:",
    "",
    ...pr.comments.map(
      (one) =>
        `- ${one.path}${one.line === null ? "" : `:${one.line}`} — ${one.author}: ${one.body.trim()}`,
    ),
    "",
    "Change the code to answer them. Do not reply in the pull request; the push is the answer.",
  ];
  return lines.join("\n");
}

function summaryOf(raw: unknown): PullRequestSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const head = row.head as { ref?: unknown; sha?: unknown } | undefined;
  const base = row.base as { ref?: unknown } | undefined;
  const user = row.user as { login?: unknown } | undefined;
  if (typeof row.number !== "number" || typeof head?.ref !== "string") return null;
  return {
    number: row.number,
    title: typeof row.title === "string" ? row.title : "",
    url: typeof row.html_url === "string" ? row.html_url : "",
    state: typeof row.state === "string" ? row.state : "open",
    draft: row.draft === true,
    head: { branch: head.ref, sha: typeof head.sha === "string" ? head.sha : "" },
    base: { branch: typeof base?.ref === "string" ? base.ref : "" },
    author: typeof user?.login === "string" ? user.login : "",
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}

function commentOf(raw: unknown): ReviewComment | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const user = row.user as { login?: unknown } | undefined;
  if (typeof row.id !== "number" || typeof row.path !== "string") return null;
  return {
    id: row.id,
    path: row.path,
    line: typeof row.line === "number" ? row.line : null,
    body: typeof row.body === "string" ? row.body : "",
    author: typeof user?.login === "string" ? user.login : "",
    diffHunk: typeof row.diff_hunk === "string" ? row.diff_hunk : null,
  };
}

function reviewOf(raw: unknown): ReviewSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const user = row.user as { login?: unknown } | undefined;
  if (typeof row.id !== "number") return null;
  return {
    id: row.id,
    author: typeof user?.login === "string" ? user.login : "",
    state: typeof row.state === "string" ? row.state : "",
    body: typeof row.body === "string" ? row.body : "",
  };
}

function checkOf(raw: unknown): CheckRun | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.name !== "string") return null;
  return {
    name: row.name,
    status: typeof row.status === "string" ? row.status : "",
    conclusion: typeof row.conclusion === "string" ? row.conclusion : null,
    url: typeof row.html_url === "string" ? row.html_url : "",
  };
}
