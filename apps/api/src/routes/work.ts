/**
 * Work items over REST (spec §7.1 `.../projects/{p}/work-items?view`, `/api/work-items/{id}`
 * (+ `start-session`); task 3.13).
 *
 * A work item is reached by its own id once it exists, the way §7.1 writes it — the project and
 * the workspace are on the row, so a caller who has one id does not have to carry three. The
 * board's list is under its project, because a board is a project's.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  WORK_ASSIGNEES,
  WORK_ITEM_STATES,
  WORK_ITEM_TYPES,
  type WorkItem,
  type WorkItemState,
} from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { findProject } from "../repos/projects.ts";
import { viewWorkItem } from "../services/work.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });
const itemParam = z.object({ id: z.uuid() });

const assigneeSchema = z
  .object({ type: z.enum(WORK_ASSIGNEES), id: z.uuid() })
  .nullable()
  .openapi("WorkAssignee");

const itemSchema = z
  .object({
    id: z.uuid(),
    /** `KEY-123` (spec §7.8): the project's key and this item's number. */
    identifier: z.string(),
    number: z.number().int(),
    project_id: z.uuid(),
    type: z.enum(WORK_ITEM_TYPES),
    title: z.string(),
    description: z.string(),
    state: z.enum(WORK_ITEM_STATES),
    /** 0 none, 1 urgent … 4 low. */
    priority: z.number().int(),
    assignee_type: z.enum(WORK_ASSIGNEES).nullable(),
    assignee_id: z.uuid().nullable(),
    labels: z.array(z.string()),
    /** The thread it was made from, when a message is where it started. */
    thread_root_id: z.uuid().nullable(),
    /** The session doing it right now, when one is. */
    session_id: z.uuid().nullable(),
    pr_url: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("WorkItem");

const boardSchema = z
  .object({ items: z.array(itemSchema), states: z.array(z.enum(WORK_ITEM_STATES)) })
  .openapi("WorkBoard");

const createBody = z
  .object({
    title: z.string().trim().min(1).max(300),
    type: z.enum(WORK_ITEM_TYPES).optional(),
    description: z.string().max(100_000).optional(),
    state: z.enum(WORK_ITEM_STATES).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    assignee: assigneeSchema.optional(),
    labels: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    /** The thread this came out of, so the conversation and the work stay one thing. */
    thread_root_id: z.uuid().optional(),
  })
  .openapi("CreateWorkItem");

const patchBody = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    type: z.enum(WORK_ITEM_TYPES).optional(),
    description: z.string().max(100_000).optional(),
    state: z.enum(WORK_ITEM_STATES).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    assignee: assigneeSchema.optional(),
    labels: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    pr_url: z.url().max(500).nullable().optional(),
  })
  .openapi("PatchWorkItem");

const startBody = z
  .object({
    engine: z.string().max(40).optional(),
    /** What to ask the agent. Without one it is sent the item's own title and description. */
    prompt: z.string().max(100_000).optional(),
  })
  .openapi("StartWorkItemSession");

const boardRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/work-items",
  tags: ["work"],
  summary: "The project's board",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    query: z.object({
      state: z.enum(WORK_ITEM_STATES).optional(),
      assignee: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
  },
  responses: {
    200: { description: "Items", content: { "application/json": { schema: boardSchema } } },
    ...errorResponses(403, 404),
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/work-items",
  tags: ["work"],
  summary: "Add a work item",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: { content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: { description: "The item", content: { "application/json": { schema: itemSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const getRouteDef = createRoute({
  method: "get",
  path: "/api/work-items/{id}",
  tags: ["work"],
  summary: "One work item",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: itemParam },
  responses: {
    200: { description: "The item", content: { "application/json": { schema: itemSchema } } },
    ...errorResponses(403, 404),
  },
});

const patchRouteDef = createRoute({
  method: "patch",
  path: "/api/work-items/{id}",
  tags: ["work"],
  summary: "Change a work item: its state, its assignee, anything on it",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: itemParam, body: { content: { "application/json": { schema: patchBody } } } },
  responses: {
    200: { description: "The item", content: { "application/json": { schema: itemSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const startRouteDef = createRoute({
  method: "post",
  path: "/api/work-items/{id}/start-session",
  tags: ["work"],
  summary: "Hand it to an agent: opens a session on the project and moves the item to running",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: itemParam, body: { content: { "application/json": { schema: startBody } } } },
  responses: {
    201: {
      description: "The item and the session now doing it",
      content: {
        "application/json": {
          schema: z
            .object({ item: itemSchema, session_id: z.uuid() })
            .openapi("WorkItemSessionStarted"),
        },
      },
    },
    ...errorResponses(403, 404, 409, 422),
  },
});

export function registerWork(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  /** The item, the project it is in, and the check that this caller may be looking at it. */
  const reach = async (
    c: Parameters<Parameters<typeof app.openapi>[1]>[0],
    id: string,
    action: "work.read" | "work.write",
  ): Promise<{ item: WorkItem; key: string }> => {
    const item = await deps.work.item(id);
    if (!item) throw PerchError.notFound("work item");
    await authorize(c, deps, action, { type: "workspace", id: item.workspaceId });
    const project = await deps.work.projectOf(item);
    return { item, key: project.key };
  };

  app.openapi(boardRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    await authorize(c, deps, "work.read", { type: "workspace", id: ws });
    const project = await findProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const query = c.req.valid("query");
    const items = await deps.work.board(project.id, {
      ...(query.state ? { states: [query.state as WorkItemState] } : {}),
      ...(query.assignee ? { assigneeId: query.assignee } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
    return c.json(
      {
        items: items.map((item) => viewWorkItem(item, project.key)),
        // The columns a board draws, in order, so the client does not keep its own copy.
        states: [...WORK_ITEM_STATES],
      },
      200,
    );
  });

  app.openapi(createRouteDef, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    await authorize(c, deps, "work.write", { type: "workspace", id: ws });
    const project = await findProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const body = c.req.valid("json");
    const item = await deps.work.create({
      project,
      userId: currentUser(c).id,
      title: body.title,
      by: actorOf(c),
      ...(body.type ? { type: body.type } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.state ? { state: body.state } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.assignee !== undefined ? { assignee: body.assignee } : {}),
      ...(body.labels ? { labels: body.labels } : {}),
      // A thread is where it came from, which is what `source: message` records.
      ...(body.thread_root_id
        ? { threadRootId: body.thread_root_id, source: "message" as const }
        : {}),
    });
    return c.json(viewWorkItem(item, project.key), 201);
  });

  app.openapi(getRouteDef, async (c) => {
    const { item, key } = await reach(c, c.req.valid("param").id, "work.read");
    return c.json(viewWorkItem(item, key), 200);
  });

  app.openapi(patchRouteDef, async (c) => {
    const { item, key } = await reach(c, c.req.valid("param").id, "work.write");
    const body = c.req.valid("json");
    const updated = await deps.work.update(
      item,
      {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.state !== undefined ? { state: body.state } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.assignee !== undefined ? { assignee: body.assignee } : {}),
        ...(body.labels !== undefined ? { labels: body.labels } : {}),
        ...(body.pr_url !== undefined ? { prUrl: body.pr_url } : {}),
      },
      actorOf(c),
    );
    return c.json(viewWorkItem(updated, key), 200);
  });

  app.openapi(startRouteDef, async (c) => {
    const { item, key } = await reach(c, c.req.valid("param").id, "work.write");
    // Opening a session is a session decision as well as a work one.
    await authorize(c, deps, "sessions.create", { type: "workspace", id: item.workspaceId });
    const body = c.req.valid("json");
    const started = await deps.work.startSession(item, {
      userId: currentUser(c).id,
      by: actorOf(c),
      ...(body.engine ? { engine: body.engine } : {}),
      ...(body.prompt ? { prompt: body.prompt } : {}),
    });
    return c.json({ item: viewWorkItem(started.item, key), session_id: started.sessionId }, 201);
  });
}
