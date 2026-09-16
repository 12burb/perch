/**
 * The merge queue over REST (spec §5.7; task 3.15). A branch joins from a work item — that is
 * what the board's agents produce — or by name, for a branch somebody wrote themselves.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { MERGE_FAILURES, MERGE_STATES } from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { findProject } from "../repos/projects.ts";
import { sessionsForWorkItem } from "../repos/sessions.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });

const entrySchema = z
  .object({
    id: z.uuid(),
    project_id: z.uuid(),
    work_item_id: z.uuid().nullable(),
    session_id: z.uuid().nullable(),
    branch: z.string(),
    base: z.string(),
    state: z.enum(MERGE_STATES),
    position: z.number().int(),
    failure: z.enum(MERGE_FAILURES).nullable(),
    /** git's words, or the tail of the check command's output. Never a credential. */
    detail: z.string().nullable(),
    /** The commit the base moved to, when it landed. */
    head: z.string().nullable(),
    created_at: z.string(),
    finished_at: z.string().nullable(),
  })
  .openapi("MergeQueueEntry");

const queueRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/merge-queue",
  tags: ["work"],
  summary: "What is waiting to land on this project, in the order it will",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: {
      description: "The queue",
      content: {
        "application/json": {
          schema: z
            .object({ entries: z.array(entrySchema), checks: z.string().nullable() })
            .openapi("MergeQueue"),
        },
      },
    },
    ...errorResponses(403, 404),
  },
});

const addRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/merge-queue",
  tags: ["work"],
  summary: "Put a branch in the queue: it lands behind everything already there",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              branch: z.string().trim().min(1).max(300).optional(),
              /** A work item, whose agent's branch is the one that lands. */
              work_item_id: z.uuid().optional(),
              base: z.string().trim().min(1).max(300).optional(),
            })
            .openapi("QueueBranch"),
        },
      },
    },
  },
  responses: {
    201: { description: "Its place", content: { "application/json": { schema: entrySchema } } },
    ...errorResponses(403, 404, 409, 422),
  },
});

export function registerMergeQueue(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const view = (row: Awaited<ReturnType<Deps["mergeQueue"]["entry"]>>) => {
    if (!row) throw PerchError.notFound("queue entry");
    return {
      id: row.id,
      project_id: row.projectId,
      work_item_id: row.workItemId,
      session_id: row.sessionId,
      branch: row.branch,
      base: row.base,
      state: row.state,
      position: row.position,
      failure: row.failure,
      detail: row.detail,
      head: row.head,
      created_at: row.createdAt.toISOString(),
      finished_at: row.finishedAt?.toISOString() ?? null,
    };
  };

  app.openapi(queueRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    await authorize(c, deps, "work.read", { type: "workspace", id: ws });
    const project = await findProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const entries = await deps.mergeQueue.queue(project.id);
    const { MergeQueueService } = await import("../services/merge-queue.ts");
    return c.json(
      {
        entries: entries.map(view),
        // What "the project's checks" means here, so nobody has to guess.
        checks: MergeQueueService.checkCommand(project)?.command ?? null,
      },
      200,
    );
  });

  app.openapi(addRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    await authorize(c, deps, "work.write", { type: "workspace", id: ws });
    const project = await findProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const body = c.req.valid("json");

    let branch = body.branch;
    let sessionId: string | undefined;
    const item = body.work_item_id ? await deps.work.item(body.work_item_id) : null;
    if (body.work_item_id) {
      if (!item || item.workspaceId !== ws) throw PerchError.notFound("work item");
      // The branch an agent wrote is the worktree its session worked in (task 3.14).
      const sessions = await sessionsForWorkItem(deps.db.db, item.id);
      const worked = sessions.find((one) => one.worktree);
      branch ??= worked?.worktree ?? undefined;
      sessionId = worked?.id;
      if (!branch) throw PerchError.validation("that item has no branch to land");
    }
    if (!branch) throw PerchError.validation("say which branch, or which work item");

    const entry = await deps.mergeQueue.add({
      project,
      branch,
      userId: currentUser(c).id,
      by: actorOf(c),
      ...(item ? { workItem: item } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(body.base ? { base: body.base } : {}),
    });
    return c.json(view(entry), 201);
  });
}
