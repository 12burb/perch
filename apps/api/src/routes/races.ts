/**
 * Race mode over REST (spec §5.7; task 3.16): start one, look at the comparison, pick a winner.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ENTRANT_STATES, RACE_DECIDERS, RACE_STATES } from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { findProject } from "../repos/projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });

const entrantSchema = z
  .object({
    id: z.uuid(),
    session_id: z.uuid().nullable(),
    engine: z.string(),
    agent: z.string().nullable(),
    branch: z.string(),
    state: z.enum(ENTRANT_STATES),
    cost_usd: z.number().nullable(),
    files_changed: z.number().int().nullable(),
    additions: z.number().int().nullable(),
    deletions: z.number().int().nullable(),
    /** null when the project has no checks; 0 is a pass. */
    checks_exit_code: z.number().int().nullable(),
    detail: z.string().nullable(),
  })
  .openapi("RaceEntrant");

const raceSchema = z
  .object({
    id: z.uuid(),
    project_id: z.uuid(),
    work_item_id: z.uuid().nullable(),
    prompt: z.string(),
    state: z.enum(RACE_STATES),
    decided_by: z.enum(RACE_DECIDERS).nullable(),
    winner_id: z.uuid().nullable(),
    created_at: z.string(),
    entrants: z.array(entrantSchema),
  })
  .openapi("Race");

const startBody = z
  .object({
    prompt: z.string().trim().min(1).max(100_000),
    /** Two to eight of them. A race of one is a session. */
    runners: z
      .array(
        z.object({
          engine: z.string().min(1).max(40),
          agent: z.string().min(1).max(80).optional(),
        }),
      )
      .min(2)
      .max(8),
    work_item_id: z.uuid().optional(),
  })
  .openapi("StartRace");

const startRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/races",
  tags: ["work"],
  summary: "Ask several engines the same thing at once, each in its own worktree",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: { content: { "application/json": { schema: startBody } } },
  },
  responses: {
    201: { description: "The race", content: { "application/json": { schema: raceSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/races",
  tags: ["work"],
  summary: "This project's races, newest first",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: {
      description: "Races",
      content: {
        "application/json": {
          schema: z.object({ races: z.array(raceSchema) }).openapi("Races"),
        },
      },
    },
    ...errorResponses(403, 404),
  },
});

const getRouteDef = createRoute({
  method: "get",
  path: "/api/races/{id}",
  tags: ["work"],
  summary: "One race, with what each entrant did",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "The race", content: { "application/json": { schema: raceSchema } } },
    ...errorResponses(403, 404),
  },
});

const pickRoute = createRoute({
  method: "post",
  path: "/api/races/{id}/pick/{entrant}",
  tags: ["work"],
  summary: "Pick the winner: its branch is queued to land and the rest are given back",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: z.object({ id: z.uuid(), entrant: z.uuid() }) },
  responses: {
    200: {
      description: "The decided race",
      content: { "application/json": { schema: raceSchema } },
    },
    ...errorResponses(403, 404, 409),
  },
});

export function registerRaces(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const view = async (raceId: string) => {
    const race = await deps.races.race(raceId);
    if (!race) throw PerchError.notFound("race");
    const entrants = await deps.races.entrants(race.id);
    return {
      id: race.id,
      project_id: race.projectId,
      work_item_id: race.workItemId,
      prompt: race.prompt,
      state: race.state,
      decided_by: race.decidedBy,
      winner_id: race.winnerId,
      created_at: race.createdAt.toISOString(),
      entrants: entrants.map((one) => ({
        id: one.id,
        session_id: one.sessionId,
        engine: one.engine,
        agent: one.agent,
        branch: one.branch,
        state: one.state,
        cost_usd: one.costUsd === null ? null : Number(one.costUsd),
        files_changed: one.filesChanged,
        additions: one.additions,
        deletions: one.deletions,
        checks_exit_code: one.checksExitCode,
        detail: one.detail,
      })),
    };
  };

  app.openapi(startRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    await authorize(c, deps, "sessions.create", { type: "workspace", id: ws });
    const project = await findProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const body = c.req.valid("json");
    const item = body.work_item_id ? await deps.work.item(body.work_item_id) : null;
    if (body.work_item_id && (!item || item.workspaceId !== ws)) {
      throw PerchError.notFound("work item");
    }
    const { race } = await deps.races.start({
      project,
      prompt: body.prompt,
      runners: body.runners.map((one) => ({
        engine: one.engine,
        ...(one.agent ? { agent: one.agent } : {}),
      })),
      userId: currentUser(c).id,
      by: actorOf(c),
      ...(item ? { workItem: item } : {}),
    });
    return c.json(await view(race.id), 201);
  });

  app.openapi(listRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    await authorize(c, deps, "sessions.read", { type: "workspace", id: ws });
    const project = await findProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const rows = await deps.races.races(project.id);
    return c.json({ races: await Promise.all(rows.map((one) => view(one.id))) }, 200);
  });

  app.openapi(getRouteDef, async (c) => {
    const race = await deps.races.race(c.req.valid("param").id);
    if (!race) throw PerchError.notFound("race");
    await authorize(c, deps, "sessions.read", { type: "workspace", id: race.workspaceId });
    return c.json(await view(race.id), 200);
  });

  app.openapi(pickRoute, async (c) => {
    const { id, entrant } = c.req.valid("param");
    const race = await deps.races.race(id);
    if (!race) throw PerchError.notFound("race");
    await authorize(c, deps, "sessions.update", { type: "workspace", id: race.workspaceId });
    const chosen = await deps.races.entrants(race.id);
    if (!chosen.some((one) => one.id === entrant)) throw PerchError.notFound("entrant");
    await deps.races.pick(entrant, { userId: currentUser(c).id, by: actorOf(c) });
    return c.json(await view(race.id), 200);
  });
}
