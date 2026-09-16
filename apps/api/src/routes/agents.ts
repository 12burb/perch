/**
 * Agent presence over REST (spec §5.7; task 3.19): the list of what is working, and one Stop that
 * does not care which kind of thing it is stopping.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { actorOf, authorize } from "../auth/authorize.ts";
import { requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const wsParam = z.object({ ws: z.uuid() });

const agentSchema = z
  .object({
    kind: z.enum(["session", "bot"]),
    id: z.uuid(),
    title: z.string(),
    /** A session's status, or a run's. */
    state: z.string(),
    engine: z.string().nullable(),
    project: z.object({ id: z.uuid(), key: z.string(), name: z.string() }).nullable(),
    bot: z.object({ id: z.uuid(), name: z.string(), handle: z.string() }).nullable(),
    started_at: z.string(),
    turns: z.number().int().nullable(),
    cost_usd: z.number(),
    /** Where to go and look at it in this Perch. */
    url: z.string(),
  })
  .openapi("Agent");

const listRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/agents",
  tags: ["agents"],
  summary: "Every session and bot working right now, oldest first",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "What is working",
      content: { "application/json": { schema: z.object({ agents: z.array(agentSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const stopRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/agents/{kind}/{id}/stop",
  tags: ["agents"],
  summary: "Stop a running session or bot run",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam.extend({ kind: z.enum(["session", "bot"]), id: z.uuid() }) },
  responses: {
    200: {
      description: "Whether there was anything left to stop",
      content: { "application/json": { schema: z.object({ stopped: z.boolean() }) } },
    },
    ...errorResponses(403, 404, 502),
  },
});

export function registerAgents(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.openapi(listRoute, async (c) => {
    const { ws } = c.req.valid("param");
    // Reading the floor is reading sessions: somebody who may not see them may not count them.
    await authorize(c, deps, "sessions.read", { type: "workspace", id: ws });
    const rows = await deps.agents.list(ws);
    return c.json(
      {
        agents: rows.map((one) => ({
          kind: one.kind,
          id: one.id,
          title: one.title,
          state: one.state,
          engine: one.engine,
          project: one.project,
          bot: one.bot,
          started_at: one.startedAt.toISOString(),
          turns: one.turns,
          cost_usd: one.costUsd,
          url: one.url,
        })),
      },
      200,
    );
  });

  app.openapi(stopRoute, async (c) => {
    const { ws, kind, id } = c.req.valid("param");
    // Stopping one is a write, and the same right that opens a session closes one.
    await authorize(c, deps, "sessions.create", { type: "workspace", id: ws });
    return c.json(await deps.agents.stop(ws, kind, id, actorOf(c)), 200);
  });
}
