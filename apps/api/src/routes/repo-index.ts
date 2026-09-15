/**
 * The codebase index over REST (spec §5.7, §7.1 `.../projects (+ clone, env, config)`; task 2.17).
 *
 * Indexing is asked for and answered on a job, because reading a repository takes longer than a
 * request should: the POST returns what is queued, and `project.updated` says when it landed.
 * Searching is a plain read, and the AGENTS.md draft is text this hands back for a person to keep.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { REPO_CHUNK_KINDS } from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { getProject, projectRunnerLink } from "../services/projects.ts";
import { hitView, REPO_INDEX_QUEUE, requireIndexed } from "../services/repo-index.ts";
import { projectDeps } from "./projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });

const statusSchema = z
  .object({
    chunks: z.number().int(),
    files: z.number().int(),
    commit_sha: z.string().nullable(),
    /** How many chunks carry a vector; zero means the words are all there is. */
    embedded: z.number().int(),
    indexed_at: z.string().nullable(),
    /** The brain this workspace embeds with, when one is named. */
    embedding_model: z.string().nullable(),
  })
  .openapi("RepoIndexStatus");

const hitSchema = z
  .object({
    path: z.string(),
    symbol: z.string().nullable(),
    kind: z.enum(REPO_CHUNK_KINDS),
    start_line: z.number().int(),
    end_line: z.number().int(),
    content: z.string(),
    score: z.number(),
  })
  .openapi("RepoHit");

const statusRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/index",
  tags: ["projects"],
  summary: "What Perch has indexed of this project",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: { description: "The index", content: { "application/json": { schema: statusSchema } } },
    ...errorResponses(403, 404),
  },
});

const reindexRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/index",
  tags: ["projects"],
  summary: "Index this project's files, on a job",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              /** Wait for the pass to finish rather than queueing it; for scripts and tests. */
              wait: z.boolean().default(false),
            })
            .openapi("Reindex"),
        },
      },
    },
  },
  responses: {
    202: {
      description: "Queued, or — with `wait` — what the pass indexed",
      content: {
        "application/json": {
          schema: z
            .object({
              queued: z.boolean(),
              chunks: z.number().int().nullable(),
              files: z.number().int().nullable(),
              embedded: z.number().int().nullable(),
              /** Why nothing was embedded, when nothing was. */
              embedding_skipped: z.string().nullable(),
            })
            .openapi("ReindexStarted"),
        },
      },
    },
    ...errorResponses(403, 404, 409, 422),
  },
});

const searchRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/codebase",
  tags: ["projects"],
  summary: "Ask the index a question",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    query: z.object({
      q: z.string().min(1).max(1000),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
  },
  responses: {
    200: {
      description: "What the index knows, best first",
      content: { "application/json": { schema: z.object({ hits: z.array(hitSchema) }) } },
    },
    ...errorResponses(403, 404, 409, 422),
  },
});

const draftRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/agents-draft",
  tags: ["projects"],
  summary: "Draft an AGENTS.md from what this repository shows",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              /** Write it into the project as AGENTS.md rather than only answering with it. */
              save: z.boolean().default(false),
            })
            .openapi("AgentsDraft"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "The draft",
      content: {
        "application/json": {
          schema: z
            .object({ markdown: z.string(), saved_to: z.string().nullable() })
            .openapi("AgentsDraftResult"),
        },
      },
    },
    ...errorResponses(403, 404, 409, 422),
  },
});

export function registerRepoIndex(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const target = async (ws: string, id: string) => {
    const project = await getProject(deps.db.db, ws, id);
    if (!project) throw PerchError.notFound("project");
    return project;
  };

  app.openapi(statusRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    await authorize(c, deps, "projects.read", { type: "workspace", id: ws });
    const project = await target(ws, id);
    const [status, profile] = await Promise.all([
      deps.repoIndex.status(project.id),
      deps.repoIndex.embeddingProfile(ws),
    ]);
    return c.json(
      {
        chunks: status.chunks,
        files: status.files,
        commit_sha: status.commitSha,
        embedded: status.embedded,
        indexed_at: status.indexedAt,
        embedding_model: profile?.name ?? null,
      },
      200,
    );
  });

  app.openapi(reindexRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const project = await target(ws, id);
    const user = currentUser(c);
    if (!body.wait) {
      await deps.queue.enqueue({
        queue: REPO_INDEX_QUEUE,
        payload: { workspaceId: ws, projectId: project.id, userId: user.id },
      });
      return c.json(
        { queued: true, chunks: null, files: null, embedded: null, embedding_skipped: null },
        202,
      );
    }
    const link = await projectRunnerLink(projectDeps(deps), project, user.id);
    const result = await deps.repoIndex.index({
      project,
      link,
      userId: user.id,
      by: actorOf(c),
    });
    return c.json(
      {
        queued: false,
        chunks: result.chunks,
        files: result.files,
        embedded: result.embedded,
        embedding_skipped: result.embeddingSkipped ?? null,
      },
      202,
    );
  });

  app.openapi(searchRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const { q, limit } = c.req.valid("query");
    await authorize(c, deps, "projects.read", { type: "workspace", id: ws });
    const project = await target(ws, id);
    // An empty index says so rather than answering "nothing found": the two mean different things,
    // and only one of them is fixed by pressing Index.
    requireIndexed(await deps.repoIndex.status(project.id));
    const hits = await deps.repoIndex.search({
      project,
      userId: currentUser(c).id,
      query: q,
      ...(limit === undefined ? {} : { limit }),
    });
    return c.json({ hits: hits.map(hitView) }, 200);
  });

  app.openapi(draftRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const project = await target(ws, id);
    const user = currentUser(c);
    const link = await projectRunnerLink(projectDeps(deps), project, user.id);
    const markdown = await deps.repoIndex.agentsDraft({ project, link, userId: user.id });
    if (!body.save) return c.json({ markdown, saved_to: null }, 200);
    await deps.repoIndex.writeDraft({ project, link, userId: user.id, markdown });
    return c.json({ markdown, saved_to: "AGENTS.md" }, 200);
  });
}
