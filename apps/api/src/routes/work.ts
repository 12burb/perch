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
  type SavedView,
  VIEW_LAYOUTS,
  viewDisplaySchema,
  viewFiltersSchema,
  WORK_ASSIGNEES,
  WORK_ITEM_STATES,
  WORK_ITEM_TYPES,
  WORK_RELATION_KINDS,
  type WorkItem,
  type WorkItemState,
} from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { findProject } from "../repos/projects.ts";
import { optionsFrom } from "../repos/work.ts";
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
    /** §4's rich description, when one has been written; the plain text is always there too. */
    description_doc: z.unknown().nullable(),
    cycle_id: z.uuid().nullable(),
    module_id: z.uuid().nullable(),
    parent_id: z.uuid().nullable(),
    estimate: z.number().nullable(),
    due_at: z.string().nullable(),
    /** `pending`, `accepted` or `declined` for something that arrived through intake. */
    intake_status: z.string().nullable(),
    completed_at: z.string().nullable(),
    /** The thread it was made from, when a message is where it started. */
    thread_root_id: z.uuid().nullable(),
    /** The session doing it right now, when one is. */
    session_id: z.uuid().nullable(),
    pr_url: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("WorkItem");

export const savedViewSchema = z
  .object({
    id: z.uuid(),
    project_id: z.uuid().nullable(),
    owner_id: z.uuid().nullable(),
    name: z.string(),
    layout: z.enum(VIEW_LAYOUTS),
    filters: viewFiltersSchema,
    display: viewDisplaySchema,
    shared: z.boolean(),
    created_at: z.string(),
  })
  .openapi("SavedView");

export function viewSaved(row: SavedView) {
  return {
    id: row.id,
    project_id: row.projectId,
    owner_id: row.ownerId,
    name: row.name,
    layout: row.layout,
    filters: row.filters,
    display: row.display,
    shared: row.shared,
    created_at: row.createdAt.toISOString(),
  };
}

/** A work item on the wire, exported so the intake routes answer with the same shape. */
export const workItemSchema = itemSchema;

const boardSchema = z
  .object({
    items: z.array(itemSchema),
    states: z.array(z.enum(WORK_ITEM_STATES)),
    /**
     * The saved view this list came from, when one was asked for (task 3.26). Absent rather than
     * null: a nullable `$ref` would make `SavedView` itself nullable everywhere it is used.
     */
    view: savedViewSchema.optional(),
  })
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
    /** Where it is planned, so quick-add's `cycle:12` lands somewhere (task 3.26). */
    cycle_id: z.uuid().nullable().optional(),
    module_id: z.uuid().nullable().optional(),
    parent_id: z.uuid().nullable().optional(),
    estimate: z.number().min(0).max(1000).nullable().optional(),
    due_at: z.iso.datetime().nullable().optional(),
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
    /** The Tiptap document §4 asks for; `null` takes it away and leaves the text. */
    description_doc: z.unknown().optional(),
    cycle_id: z.uuid().nullable().optional(),
    module_id: z.uuid().nullable().optional(),
    parent_id: z.uuid().nullable().optional(),
    estimate: z.number().min(0).max(1000).nullable().optional(),
    due_at: z.iso.datetime().nullable().optional(),
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
      /** A saved view's id: its filters and its display decide what comes back (task 3.26). */
      view: z.uuid().optional(),
      cycle: z.uuid().optional(),
      module: z.uuid().optional(),
      type: z.enum(WORK_ITEM_TYPES).optional(),
      label: z.string().max(64).optional(),
      q: z.string().max(200).optional(),
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

/**
 * What it cost and where the time went (spec §5.7 "cost rolled up to the work item"; task 3.22).
 * Nothing here is stored: it is the item's own sessions, added up at the moment you ask.
 */
const costRouteDef = createRoute({
  method: "get",
  path: "/api/work-items/{id}/cost",
  tags: ["work"],
  summary: "What this item cost, and where its time went",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: "The rollup",
      content: {
        "application/json": {
          schema: z
            .object({
              cost_usd: z.number(),
              elapsed_ms: z.number().int(),
              working_ms: z.number().int(),
              turns: z.number().int(),
              sessions: z.array(
                z.object({
                  id: z.uuid(),
                  engine: z.string(),
                  status: z.string(),
                  cost_usd: z.number(),
                  turns: z.number().int(),
                  elapsed_ms: z.number().int(),
                }),
              ),
            })
            .openapi("WorkItemCost"),
        },
      },
    },
    ...errorResponses(403, 404),
  },
});

const relationSchema = z
  .object({
    kind: z.enum(WORK_RELATION_KINDS),
    related_id: z.uuid(),
    /** The item on the other end, so a panel shows a title rather than an id. */
    item: itemSchema.nullable(),
  })
  .openapi("WorkItemRelation");

const relationsRoute = createRoute({
  method: "get",
  path: "/api/work-items/{id}/relations",
  tags: ["work"],
  summary: "What this item blocks, is blocked by, relates to or duplicates — and its sub-items",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: itemParam },
  responses: {
    200: {
      description: "Relations and children",
      content: {
        "application/json": {
          schema: z
            .object({ relations: z.array(relationSchema), children: z.array(itemSchema) })
            .openapi("WorkItemRelations"),
        },
      },
    },
    ...errorResponses(403, 404),
  },
});

const relateRoute = createRoute({
  method: "post",
  path: "/api/work-items/{id}/relations",
  tags: ["work"],
  summary: "Relate two items; the other end is written too",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: itemParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ related_id: z.uuid(), kind: z.enum(WORK_RELATION_KINDS) })
            .openapi("RelateWorkItem"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "The relation",
      content: { "application/json": { schema: relationSchema } },
    },
    ...errorResponses(403, 404, 422),
  },
});

const unrelateRoute = createRoute({
  method: "delete",
  path: "/api/work-items/{id}/relations/{kind}/{related}",
  tags: ["work"],
  summary: "Take a relation away, from both ends",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: itemParam.extend({ kind: z.enum(WORK_RELATION_KINDS), related: z.uuid() }),
  },
  responses: { 204: { description: "Gone" }, ...errorResponses(403, 404) },
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
    // A saved view is the base, and anything in the query narrows it further: opening a view and
    // then typing in the search box should not throw the view away (task 3.26).
    let options = {};
    let view = null;
    if (query.view) {
      const saved = await deps.planning.view(query.view);
      if (!saved || saved.workspaceId !== ws) throw PerchError.notFound("view");
      if (!deps.planning.mayRead(saved, currentUser(c).id)) throw PerchError.notFound("view");
      options = optionsFrom(saved.filters, saved.display);
      view = saved;
    }
    const items = await deps.work.board(project.id, {
      ...options,
      ...(query.state ? { states: [query.state as WorkItemState] } : {}),
      ...(query.assignee ? { assigneeId: query.assignee } : {}),
      ...(query.cycle ? { cycleId: query.cycle } : {}),
      ...(query.module ? { moduleId: query.module } : {}),
      ...(query.type ? { types: [query.type] } : {}),
      ...(query.label ? { labels: [query.label] } : {}),
      ...(query.q ? { search: query.q } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
    return c.json(
      {
        items: items.map((item) => viewWorkItem(item, project.key)),
        // The columns a board draws, in order, so the client does not keep its own copy.
        states: [...WORK_ITEM_STATES],
        ...(view ? { view: viewSaved(view) } : {}),
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
    // Where it is planned is a patch on the way out, so one door owns the rules about parents,
    // cycles and estimates rather than two.
    const planned =
      body.cycle_id !== undefined ||
      body.module_id !== undefined ||
      body.parent_id !== undefined ||
      body.estimate !== undefined ||
      body.due_at !== undefined
        ? await deps.work.update(
            item,
            {
              ...(body.cycle_id !== undefined ? { cycleId: body.cycle_id } : {}),
              ...(body.module_id !== undefined ? { moduleId: body.module_id } : {}),
              ...(body.parent_id !== undefined ? { parentId: body.parent_id } : {}),
              ...(body.estimate !== undefined ? { estimate: body.estimate } : {}),
              ...(body.due_at !== undefined
                ? { dueAt: body.due_at === null ? null : new Date(body.due_at) }
                : {}),
            },
            actorOf(c),
          )
        : item;
    return c.json(viewWorkItem(planned, project.key), 201);
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
        ...(body.description_doc !== undefined ? { descriptionDoc: body.description_doc } : {}),
        ...(body.cycle_id !== undefined ? { cycleId: body.cycle_id } : {}),
        ...(body.module_id !== undefined ? { moduleId: body.module_id } : {}),
        ...(body.parent_id !== undefined ? { parentId: body.parent_id } : {}),
        ...(body.estimate !== undefined ? { estimate: body.estimate } : {}),
        ...(body.due_at !== undefined
          ? { dueAt: body.due_at === null ? null : new Date(body.due_at) }
          : {}),
      },
      actorOf(c),
    );
    return c.json(viewWorkItem(updated, key), 200);
  });
  app.openapi(relationsRoute, async (c) => {
    const { item, key } = await reach(c, c.req.valid("param").id, "work.read");
    const [relations, children] = await Promise.all([
      deps.planning.relations(item.id),
      deps.planning.children(item.id),
    ]);
    return c.json(
      {
        relations: relations.map((one) => ({
          kind: one.relation.kind,
          related_id: one.relation.relatedId,
          item: one.item ? viewWorkItem(one.item, key) : null,
        })),
        children: children.map((child) => viewWorkItem(child, key)),
      },
      200,
    );
  });

  app.openapi(relateRoute, async (c) => {
    const { item, key } = await reach(c, c.req.valid("param").id, "work.write");
    const body = c.req.valid("json");
    const relation = await deps.planning.relate({
      workspaceId: item.workspaceId,
      item,
      relatedId: body.related_id,
      kind: body.kind,
      by: actorOf(c),
    });
    const other = await deps.work.item(relation.relatedId);
    return c.json(
      {
        kind: relation.kind,
        related_id: relation.relatedId,
        item: other ? viewWorkItem(other, key) : null,
      },
      201,
    );
  });

  app.openapi(unrelateRoute, async (c) => {
    const { kind, related } = c.req.valid("param");
    const { item } = await reach(c, c.req.valid("param").id, "work.write");
    const gone = await deps.planning.unrelate({
      workspaceId: item.workspaceId,
      item,
      relatedId: related,
      kind,
      by: actorOf(c),
    });
    if (!gone) throw PerchError.notFound("relation");
    return c.body(null, 204);
  });

  app.openapi(costRouteDef, async (c) => {
    const { item } = await reach(c, c.req.valid("param").id, "work.read");
    const rolled = await deps.work.cost(item.id);
    return c.json(
      {
        cost_usd: rolled.costUsd,
        elapsed_ms: rolled.elapsedMs,
        working_ms: rolled.workingMs,
        turns: rolled.turns,
        sessions: rolled.sessions.map((one) => ({
          id: one.id,
          engine: one.engine,
          status: one.status,
          cost_usd: one.costUsd,
          turns: one.turns,
          elapsed_ms: one.elapsedMs,
        })),
      },
      200,
    );
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
