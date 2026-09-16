/**
 * The Pull Requests page over REST (spec §5.1; task 3.20): the connection's pull requests, one of
 * them with its inline comments and checks, a review, and the button that hands the review to an
 * agent.
 *
 * Every one of these takes a `connection_id`, because the pull requests belong to the connection
 * rather than to Perch — the same reason there is no `pull_requests` table.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { findProject } from "../repos/projects.ts";
import { projectRunnerLink } from "../services/projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });
const numbered = projectParam.extend({ number: z.coerce.number().int().positive() });
const through = z.object({ connection_id: z.uuid() });

const summarySchema = z
  .object({
    number: z.number().int(),
    title: z.string(),
    url: z.string(),
    state: z.string(),
    draft: z.boolean(),
    head: z.object({ branch: z.string(), sha: z.string() }),
    base: z.object({ branch: z.string() }),
    author: z.string(),
    updated_at: z.string(),
  })
  .openapi("PullRequestSummary");

const detailSchema = summarySchema
  .extend({
    body: z.string(),
    comments: z.array(
      z.object({
        id: z.number().int(),
        path: z.string(),
        line: z.number().int().nullable(),
        body: z.string(),
        author: z.string(),
        diff_hunk: z.string().nullable(),
      }),
    ),
    reviews: z.array(
      z.object({
        id: z.number().int(),
        author: z.string(),
        state: z.string(),
        body: z.string(),
      }),
    ),
    checks: z.array(
      z.object({
        name: z.string(),
        status: z.string(),
        conclusion: z.string().nullable(),
        url: z.string(),
      }),
    ),
  })
  // `PullRequest` is already the shape task 1.20 answers with when it opens one; this is the
  // page's fuller view of one that exists.
  .openapi("PullRequestDetail");

const listRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/pull-requests",
  tags: ["pull-requests"],
  summary: "The connection's open pull requests for this project",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam, query: through },
  responses: {
    200: {
      description: "Pull requests",
      content: {
        "application/json": { schema: z.object({ pull_requests: z.array(summarySchema) }) },
      },
    },
    ...errorResponses(403, 404, 422, 502),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/pull-requests/{number}",
  tags: ["pull-requests"],
  summary: "One pull request, with its inline comments, its reviews and its checks",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: numbered, query: through },
  responses: {
    200: {
      description: "The pull request",
      content: { "application/json": { schema: detailSchema } },
    },
    ...errorResponses(403, 404, 422, 502),
  },
});

const reviewRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/pull-requests/{number}/reviews",
  tags: ["pull-requests"],
  summary: "Approve, request changes, or comment",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: numbered,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            connection_id: z.uuid(),
            verdict: z.enum(["approve", "request_changes", "comment"]),
            body: z.string().max(60_000).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "The review",
      content: {
        "application/json": { schema: z.object({ id: z.number().int(), state: z.string() }) },
      },
    },
    ...errorResponses(403, 404, 422, 502),
  },
});

const addressRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/pull-requests/{number}/address",
  tags: ["pull-requests"],
  summary: "Ask the agent to address the review: a session on the branch, the comments as its turn",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: numbered,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            connection_id: z.uuid(),
            engine: z.string().min(1).max(64).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "The session that is answering it",
      content: {
        "application/json": {
          schema: z.object({
            session_id: z.uuid(),
            comments: z.number().int(),
            branch: z.string(),
          }),
        },
      },
    },
    ...errorResponses(403, 404, 422, 502),
  },
});

export function registerPullRequests(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const where = async (ws: string, projectId: string) => {
    const project = await findProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    return project;
  };

  app.openapi(listRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    await authorize(c, deps, "projects.read", { type: "workspace", id: ws });
    const project = await where(ws, projectId);
    const rows = await deps.pullRequests.list({
      project,
      userId: currentUser(c).id,
      connectionId: c.req.valid("query").connection_id,
    });
    return c.json({ pull_requests: rows.map(wire) }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const { ws, project: projectId, number } = c.req.valid("param");
    await authorize(c, deps, "projects.read", { type: "workspace", id: ws });
    const project = await where(ws, projectId);
    const pr = await deps.pullRequests.get(
      { project, userId: currentUser(c).id, connectionId: c.req.valid("query").connection_id },
      number,
    );
    return c.json(
      {
        ...wire(pr),
        body: pr.body,
        comments: pr.comments.map((one) => ({
          id: one.id,
          path: one.path,
          line: one.line,
          body: one.body,
          author: one.author,
          diff_hunk: one.diffHunk,
        })),
        reviews: pr.reviews,
        checks: pr.checks,
      },
      200,
    );
  });

  app.openapi(reviewRoute, async (c) => {
    const { ws, project: projectId, number } = c.req.valid("param");
    // Reviewing is writing to the repository, the same right that opens a pull request.
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const project = await where(ws, projectId);
    const body = c.req.valid("json");
    const done = await deps.pullRequests.review(
      { project, userId: currentUser(c).id, connectionId: body.connection_id },
      number,
      { verdict: body.verdict, ...(body.body ? { body: body.body } : {}) },
    );
    return c.json(done, 201);
  });

  app.openapi(addressRoute, async (c) => {
    const { ws, project: projectId, number } = c.req.valid("param");
    await authorize(c, deps, "sessions.create", { type: "workspace", id: ws });
    const project = await where(ws, projectId);
    const body = c.req.valid("json");
    const user = currentUser(c);
    const link = await projectRunnerLink(
      { db: deps.db.db, registry: deps.runners },
      project,
      user.id,
    );
    const started = await deps.pullRequests.address(
      { project, userId: user.id, connectionId: body.connection_id },
      number,
      { link, by: actorOf(c), ...(body.engine ? { engine: body.engine } : {}) },
    );
    return c.json(
      { session_id: started.sessionId, comments: started.comments, branch: started.branch },
      201,
    );
  });
}

function wire(one: {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  head: { branch: string; sha: string };
  base: { branch: string };
  author: string;
  updatedAt: string;
}) {
  return {
    number: one.number,
    title: one.title,
    url: one.url,
    state: one.state,
    draft: one.draft,
    head: one.head,
    base: one.base,
    author: one.author,
    updated_at: one.updatedAt,
  };
}
