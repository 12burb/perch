/**
 * Cycles, modules, saved views, and the intake queue over REST (spec §7.1 `.../cycles`,
 * `.../modules`, `.../views`, `.../projects/{p}/intake`, `/api/work-items/{id}/intake/accept|decline`;
 * task 3.26).
 *
 * A cycle and a module belong to a project, so they are made under one and reached by their own id
 * afterwards — the same shape §7.1 gives work items. A view belongs to a workspace and may name a
 * project, because "everything assigned to me" is not one repository's question.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  CYCLE_STATUSES,
  type Cycle,
  type Module,
  type SavedView,
  VIEW_LAYOUTS,
  viewDisplaySchema,
  viewFiltersSchema,
  WORK_ITEM_STATES,
  WORK_ITEM_TYPES,
} from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { findProject, projectById } from "../repos/projects.ts";
import { viewWorkItem } from "../services/work.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });
const wsParam = z.object({ ws: z.uuid() });
const idParam = z.object({ id: z.uuid() });

export const cycleSchema = z
  .object({
    id: z.uuid(),
    project_id: z.uuid(),
    name: z.string(),
    starts_at: z.string().nullable(),
    ends_at: z.string().nullable(),
    status: z.enum(CYCLE_STATUSES),
    created_at: z.string(),
  })
  .openapi("Cycle");

export const moduleSchema = z
  .object({
    id: z.uuid(),
    project_id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    starts_at: z.string().nullable(),
    ends_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Module");

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

const burndownSchema = z
  .object({
    cycle_id: z.uuid(),
    scope: z.number().int(),
    scope_estimate: z.number(),
    done: z.number().int(),
    days: z.array(
      z.object({
        date: z.string(),
        remaining: z.number().int(),
        remaining_estimate: z.number(),
        done: z.number().int(),
        ideal: z.number(),
      }),
    ),
    /** Who finished the work each day: an agent's, or a person's (spec §4). */
    throughput: z.array(
      z.object({
        date: z.string(),
        by_agent: z.number().int(),
        by_person: z.number().int(),
      }),
    ),
  })
  .openapi("Burndown");

export function viewCycle(row: Cycle) {
  return {
    id: row.id,
    project_id: row.projectId,
    name: row.name,
    starts_at: row.startsAt?.toISOString() ?? null,
    ends_at: row.endsAt?.toISOString() ?? null,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  };
}

export function viewModule(row: Module) {
  return {
    id: row.id,
    project_id: row.projectId,
    name: row.name,
    description: row.description,
    starts_at: row.startsAt?.toISOString() ?? null,
    ends_at: row.endsAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

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

const cycleBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    starts_at: z.iso.datetime().nullable().optional(),
    ends_at: z.iso.datetime().nullable().optional(),
  })
  .openapi("CreateCycle");

const cyclePatchBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    starts_at: z.iso.datetime().nullable().optional(),
    ends_at: z.iso.datetime().nullable().optional(),
    status: z.enum(CYCLE_STATUSES).optional(),
  })
  .openapi("PatchCycle");

const moduleBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(4_000).nullable().optional(),
    starts_at: z.iso.datetime().nullable().optional(),
    ends_at: z.iso.datetime().nullable().optional(),
  })
  .openapi("CreateModule");

const viewBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    project_id: z.uuid().nullable().optional(),
    layout: z.enum(VIEW_LAYOUTS).default("board"),
    filters: viewFiltersSchema.default({}),
    display: viewDisplaySchema.default({}),
    /** Shared views are the team's; an unshared one is only its owner's. */
    shared: z.boolean().default(false),
  })
  .openapi("CreateSavedView");

const viewPatchBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    layout: z.enum(VIEW_LAYOUTS).optional(),
    filters: viewFiltersSchema.optional(),
    display: viewDisplaySchema.optional(),
    shared: z.boolean().optional(),
  })
  .openapi("PatchSavedView");

const triageBody = z
  .object({
    /** Accepting can change the type and land it in a cycle — §4's "convert". */
    type: z.enum(WORK_ITEM_TYPES).optional(),
    cycle_id: z.uuid().nullable().optional(),
  })
  .openapi("TriageWorkItem");

const listCyclesRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/cycles",
  tags: ["work"],
  summary: "The project's cycles",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: {
      description: "Cycles",
      content: { "application/json": { schema: z.object({ cycles: z.array(cycleSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const createCycleRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/cycles",
  tags: ["work"],
  summary: "Add a cycle",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: { content: { "application/json": { schema: cycleBody } } },
  },
  responses: {
    201: { description: "The cycle", content: { "application/json": { schema: cycleSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const patchCycleRoute = createRoute({
  method: "patch",
  path: "/api/cycles/{id}",
  tags: ["work"],
  summary: "Rename a cycle or move its dates",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: idParam,
    body: { content: { "application/json": { schema: cyclePatchBody } } },
  },
  responses: {
    200: { description: "The cycle", content: { "application/json": { schema: cycleSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const deleteCycleRoute = createRoute({
  method: "delete",
  path: "/api/cycles/{id}",
  tags: ["work"],
  summary: "Take a cycle away; its items keep their state and lose their cycle",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: idParam },
  responses: { 204: { description: "Gone" }, ...errorResponses(403, 404) },
});

const closeCycleRoute = createRoute({
  method: "post",
  path: "/api/cycles/{id}/close",
  tags: ["work"],
  summary: "Close a cycle: unfinished work carries over, and the burndown is what it was",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: idParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              /** The cycle the unfinished work moves to; without one it goes back to no cycle. */
              into: z.uuid().nullable().optional(),
            })
            .openapi("CloseCycle"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "The closed cycle, what carried over, and the burndown it ended on",
      content: {
        "application/json": {
          schema: z
            .object({
              cycle: cycleSchema,
              carried_over: z.number().int(),
              burndown: burndownSchema,
            })
            .openapi("ClosedCycle"),
        },
      },
    },
    ...errorResponses(403, 404, 422),
  },
});

const burndownRoute = createRoute({
  method: "get",
  path: "/api/cycles/{id}/burndown",
  tags: ["work"],
  summary: "What is left in this cycle, day by day, and who is finishing it",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: idParam },
  responses: {
    200: {
      description: "The burndown",
      content: { "application/json": { schema: burndownSchema } },
    },
    ...errorResponses(403, 404),
  },
});

const listModulesRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/modules",
  tags: ["work"],
  summary: "The project's modules",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: {
      description: "Modules",
      content: { "application/json": { schema: z.object({ modules: z.array(moduleSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const createModuleRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/modules",
  tags: ["work"],
  summary: "Add a module",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: { content: { "application/json": { schema: moduleBody } } },
  },
  responses: {
    201: { description: "The module", content: { "application/json": { schema: moduleSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const patchModuleRoute = createRoute({
  method: "patch",
  path: "/api/modules/{id}",
  tags: ["work"],
  summary: "Edit a module",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: idParam,
    body: { content: { "application/json": { schema: moduleBody.partial() } } },
  },
  responses: {
    200: { description: "The module", content: { "application/json": { schema: moduleSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const deleteModuleRoute = createRoute({
  method: "delete",
  path: "/api/modules/{id}",
  tags: ["work"],
  summary: "Take a module away",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: idParam },
  responses: { 204: { description: "Gone" }, ...errorResponses(403, 404) },
});

const listViewsRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/views",
  tags: ["work"],
  summary: "The views this person can see: their own, and the shared ones",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam, query: z.object({ project: z.uuid().optional() }) },
  responses: {
    200: {
      description: "Views",
      content: { "application/json": { schema: z.object({ views: z.array(savedViewSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const createViewRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/views",
  tags: ["work"],
  summary: "Save a view",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam, body: { content: { "application/json": { schema: viewBody } } } },
  responses: {
    201: { description: "The view", content: { "application/json": { schema: savedViewSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const patchViewRoute = createRoute({
  method: "patch",
  path: "/api/views/{id}",
  tags: ["work"],
  summary: "Change a saved view",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: idParam,
    body: { content: { "application/json": { schema: viewPatchBody } } },
  },
  responses: {
    200: { description: "The view", content: { "application/json": { schema: savedViewSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const deleteViewRoute = createRoute({
  method: "delete",
  path: "/api/views/{id}",
  tags: ["work"],
  summary: "Forget a saved view",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: idParam },
  responses: { 204: { description: "Gone" }, ...errorResponses(403, 404) },
});

const intakeRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/intake",
  tags: ["work"],
  summary: "What is waiting to be triaged",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: {
      description: "The queue",
      content: {
        "application/json": {
          schema: z
            .object({ items: z.array(z.unknown()), states: z.array(z.enum(WORK_ITEM_STATES)) })
            .openapi("IntakeQueue"),
        },
      },
    },
    ...errorResponses(403, 404),
  },
});

const acceptRoute = createRoute({
  method: "post",
  path: "/api/work-items/{id}/intake/accept",
  tags: ["work"],
  summary: "Take it on: it becomes this team's work, with the type and cycle you give it",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: idParam, body: { content: { "application/json": { schema: triageBody } } } },
  responses: {
    200: { description: "The item", content: { "application/json": { schema: z.unknown() } } },
    ...errorResponses(403, 404, 422),
  },
});

const declineRoute = createRoute({
  method: "post",
  path: "/api/work-items/{id}/intake/decline",
  tags: ["work"],
  summary: "Turn it down: the item is cancelled and stays findable",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: idParam },
  responses: {
    200: { description: "The item", content: { "application/json": { schema: z.unknown() } } },
    ...errorResponses(403, 404, 422),
  },
});

export function registerPlanning(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  /** A project this caller may act in, by the ids in the path. */
  const project = async (
    c: Parameters<Parameters<typeof app.openapi>[1]>[0],
    ws: string,
    id: string,
    action: "work.read" | "work.write",
  ) => {
    await authorize(c, deps, action, { type: "workspace", id: ws });
    const row = await findProject(deps.db.db, ws, id);
    if (!row) throw PerchError.notFound("project");
    return row;
  };

  /** A cycle reached by its own id, with the workspace it turns out to be in checked. */
  const cycleIn = async (
    c: Parameters<Parameters<typeof app.openapi>[1]>[0],
    id: string,
    action: "work.read" | "work.write",
  ) => {
    const row = await deps.planning.cycle(id);
    if (!row) throw PerchError.notFound("cycle");
    const owner = await projectById(deps.db.db, row.projectId);
    if (!owner) throw PerchError.notFound("cycle");
    await authorize(c, deps, action, { type: "workspace", id: owner.workspaceId });
    return { cycle: row, project: owner };
  };

  const moduleIn = async (
    c: Parameters<Parameters<typeof app.openapi>[1]>[0],
    id: string,
    action: "work.read" | "work.write",
  ) => {
    const row = await deps.planning.module(id);
    if (!row) throw PerchError.notFound("module");
    const owner = await projectById(deps.db.db, row.projectId);
    if (!owner) throw PerchError.notFound("module");
    await authorize(c, deps, action, { type: "workspace", id: owner.workspaceId });
    return { module: row, project: owner };
  };

  const date = (value: string | null | undefined): Date | null | undefined =>
    value === undefined ? undefined : value === null ? null : new Date(value);

  app.openapi(listCyclesRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const found = await project(c, ws, id, "work.read");
    return c.json({ cycles: (await deps.planning.cycles(found.id)).map(viewCycle) }, 200);
  });

  app.openapi(createCycleRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const found = await project(c, ws, id, "work.write");
    const body = c.req.valid("json");
    const cycle = await deps.planning.createCycle({
      workspaceId: ws,
      projectId: found.id,
      name: body.name,
      startsAt: date(body.starts_at) ?? null,
      endsAt: date(body.ends_at) ?? null,
      by: actorOf(c),
    });
    return c.json(viewCycle(cycle), 201);
  });

  app.openapi(patchCycleRoute, async (c) => {
    const { cycle, project: owner } = await cycleIn(c, c.req.valid("param").id, "work.write");
    const body = c.req.valid("json");
    const updated = await deps.planning.patchCycle(
      owner.workspaceId,
      cycle,
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.starts_at !== undefined ? { startsAt: date(body.starts_at) ?? null } : {}),
        ...(body.ends_at !== undefined ? { endsAt: date(body.ends_at) ?? null } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
      actorOf(c),
    );
    return c.json(viewCycle(updated), 200);
  });

  app.openapi(deleteCycleRoute, async (c) => {
    const { cycle, project: owner } = await cycleIn(c, c.req.valid("param").id, "work.write");
    await deps.planning.removeCycle(owner.workspaceId, cycle, actorOf(c));
    return c.body(null, 204);
  });

  app.openapi(closeCycleRoute, async (c) => {
    const { cycle, project: owner } = await cycleIn(c, c.req.valid("param").id, "work.write");
    const body = c.req.valid("json");
    const closed = await deps.planning.closeCycle(owner.workspaceId, cycle, {
      ...(body.into !== undefined ? { into: body.into } : {}),
      by: actorOf(c),
    });
    return c.json(
      {
        cycle: viewCycle(closed.cycle),
        carried_over: closed.carriedOver,
        burndown: viewBurndown(closed.burndown),
      },
      200,
    );
  });

  app.openapi(burndownRoute, async (c) => {
    const { cycle } = await cycleIn(c, c.req.valid("param").id, "work.read");
    return c.json(viewBurndown(await deps.planning.burndown(cycle)), 200);
  });

  app.openapi(listModulesRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const found = await project(c, ws, id, "work.read");
    return c.json({ modules: (await deps.planning.modules(found.id)).map(viewModule) }, 200);
  });

  app.openapi(createModuleRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const found = await project(c, ws, id, "work.write");
    const body = c.req.valid("json");
    const row = await deps.planning.createModule({
      workspaceId: ws,
      projectId: found.id,
      name: body.name,
      description: body.description ?? null,
      startsAt: date(body.starts_at) ?? null,
      endsAt: date(body.ends_at) ?? null,
      by: actorOf(c),
    });
    return c.json(viewModule(row), 201);
  });

  app.openapi(patchModuleRoute, async (c) => {
    const { module, project: owner } = await moduleIn(c, c.req.valid("param").id, "work.write");
    const body = c.req.valid("json");
    const row = await deps.planning.patchModule(
      owner.workspaceId,
      module,
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description ?? null } : {}),
        ...(body.starts_at !== undefined ? { startsAt: date(body.starts_at) ?? null } : {}),
        ...(body.ends_at !== undefined ? { endsAt: date(body.ends_at) ?? null } : {}),
      },
      actorOf(c),
    );
    return c.json(viewModule(row), 200);
  });

  app.openapi(deleteModuleRoute, async (c) => {
    const { module } = await moduleIn(c, c.req.valid("param").id, "work.write");
    await deps.planning.removeModule(module);
    return c.body(null, 204);
  });

  app.openapi(listViewsRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "work.read", { type: "workspace", id: ws });
    const { project: projectId } = c.req.valid("query");
    const views = await deps.planning.views(ws, currentUser(c).id, projectId);
    return c.json({ views: views.map(viewSaved) }, 200);
  });

  app.openapi(createViewRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "work.write", { type: "workspace", id: ws });
    const body = c.req.valid("json");
    if (body.project_id) {
      const owner = await findProject(deps.db.db, ws, body.project_id);
      if (!owner) throw PerchError.notFound("project");
    }
    const row = await deps.planning.createView({
      workspaceId: ws,
      projectId: body.project_id ?? null,
      userId: currentUser(c).id,
      name: body.name,
      layout: body.layout,
      filters: body.filters,
      display: body.display,
      shared: body.shared,
      by: actorOf(c),
    });
    return c.json(viewSaved(row), 201);
  });

  app.openapi(patchViewRoute, async (c) => {
    const row = await deps.planning.view(c.req.valid("param").id);
    if (!row) throw PerchError.notFound("view");
    await authorize(c, deps, "work.write", { type: "workspace", id: row.workspaceId });
    // A view is somebody's: a person may change their own, and a shared one is still its owner's.
    if (row.ownerId && row.ownerId !== currentUser(c).id) throw PerchError.notFound("view");
    const body = c.req.valid("json");
    const updated = await deps.planning.patchView(
      row,
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.layout !== undefined ? { layout: body.layout } : {}),
        ...(body.filters !== undefined ? { filters: body.filters } : {}),
        ...(body.display !== undefined ? { display: body.display } : {}),
        ...(body.shared !== undefined ? { shared: body.shared } : {}),
      },
      actorOf(c),
    );
    return c.json(viewSaved(updated), 200);
  });

  app.openapi(deleteViewRoute, async (c) => {
    const row = await deps.planning.view(c.req.valid("param").id);
    if (!row) throw PerchError.notFound("view");
    await authorize(c, deps, "work.write", { type: "workspace", id: row.workspaceId });
    if (row.ownerId && row.ownerId !== currentUser(c).id) throw PerchError.notFound("view");
    await deps.planning.removeView(row, actorOf(c));
    return c.body(null, 204);
  });

  app.openapi(intakeRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const found = await project(c, ws, id, "work.read");
    const items = await deps.work.intake(found.id);
    return c.json(
      {
        items: items.map((item) => viewWorkItem(item, found.key)),
        states: [...WORK_ITEM_STATES],
      },
      200,
    );
  });

  app.openapi(acceptRoute, async (c) => {
    const item = await deps.work.item(c.req.valid("param").id);
    if (!item) throw PerchError.notFound("work item");
    await authorize(c, deps, "work.write", { type: "workspace", id: item.workspaceId });
    const body = c.req.valid("json");
    const owner = await deps.work.projectOf(item);
    const updated = await deps.work.triage(
      item,
      {
        decision: "accept",
        ...(body.type ? { type: body.type } : {}),
        ...(body.cycle_id !== undefined ? { cycleId: body.cycle_id } : {}),
      },
      actorOf(c),
    );
    return c.json(viewWorkItem(updated, owner.key), 200);
  });

  app.openapi(declineRoute, async (c) => {
    const item = await deps.work.item(c.req.valid("param").id);
    if (!item) throw PerchError.notFound("work item");
    await authorize(c, deps, "work.write", { type: "workspace", id: item.workspaceId });
    const owner = await deps.work.projectOf(item);
    const updated = await deps.work.triage(item, { decision: "decline" }, actorOf(c));
    return c.json(viewWorkItem(updated, owner.key), 200);
  });
}

/** The burndown, in the wire's own spelling. */
function viewBurndown(burndown: {
  cycleId: string;
  scope: number;
  scopeEstimate: number;
  done: number;
  days: {
    date: string;
    remaining: number;
    remainingEstimate: number;
    done: number;
    ideal: number;
  }[];
  throughput: { date: string; byAgent: number; byPerson: number }[];
}) {
  return {
    cycle_id: burndown.cycleId,
    scope: burndown.scope,
    scope_estimate: burndown.scopeEstimate,
    done: burndown.done,
    days: burndown.days.map((day) => ({
      date: day.date,
      remaining: day.remaining,
      remaining_estimate: day.remainingEstimate,
      done: day.done,
      ideal: day.ideal,
    })),
    throughput: burndown.throughput.map((day) => ({
      date: day.date,
      by_agent: day.byAgent,
      by_person: day.byPerson,
    })),
  };
}
