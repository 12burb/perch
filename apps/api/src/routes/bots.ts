/**
 * Bots over REST (spec §7.1 `.../bots (+ install, test, runs, tokens)`; task 2.6). Tokens are the
 * Bot API's, which arrives with the external bots in 2.7.
 *
 * A bot belongs to the person who made it. Everybody in the workspace sees the bots the workspace
 * can talk to; a private one is its owner's alone, and making one everybody can talk to — which
 * spends the workspace's money — is an admin's (ADR-0096).
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Bot, BotRun } from "@perch/db";
import { botBudgetSchema, botSpecSchema } from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { listBots, listRuns } from "../repos/bots.ts";
import { botFor } from "../services/bots.ts";
import { channelFor } from "../services/channels.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const workspaceParam = z.object({ ws: z.uuid() });
const botParam = z.object({ ws: z.uuid(), bot: z.uuid() });
const installParam = z.object({ ws: z.uuid(), bot: z.uuid(), channel: z.uuid() });

// The shapes come from packages/db, where the column's own schema lives; they are plain Zod, so
// they are used as they are rather than registered as named OpenAPI components.
const specSchema = botSpecSchema;
const budgetSchema = botBudgetSchema;

const botSchema = z
  .object({
    id: z.uuid(),
    handle: z.string(),
    name: z.string(),
    level: z.enum(["ui", "spec", "code", "external"]),
    spec: specSchema,
    owner_id: z.uuid(),
    visibility: z.enum(["private", "workspace"]),
    orchestrator: z.boolean(),
    budget: budgetSchema,
    status: z.enum(["active", "paused", "disabled"]),
    channels: z.array(z.uuid()).openapi({ description: "Where it has been installed" }),
    created_at: z.string(),
  })
  .openapi("Bot");

const botsSchema = z.object({ bots: z.array(botSchema) }).openapi("Bots");

const runSchema = z
  .object({
    id: z.uuid(),
    trigger: z.string(),
    trigger_ref: z.string().nullable(),
    status: z.enum(["running", "done", "error", "refused"]),
    model_id: z.string().nullable(),
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    cost_usd: z.number(),
    started_at: z.string(),
    ended_at: z.string().nullable(),
    error: z.string().nullable(),
  })
  .openapi("BotRun");

const createBody = z
  .object({
    handle: z.string().min(2).max(64),
    name: z.string().min(1).max(200),
    spec: specSchema.optional(),
    visibility: z.enum(["private", "workspace"]).optional(),
    budget: budgetSchema.optional(),
    orchestrator: z.boolean().optional(),
  })
  .openapi("NewBot");

const patchBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    spec: specSchema.optional(),
    visibility: z.enum(["private", "workspace"]).optional(),
    budget: budgetSchema.optional(),
    status: z.enum(["active", "paused", "disabled"]).optional(),
    orchestrator: z.boolean().optional(),
  })
  .openapi("PatchBot");

const installBody = z.object({ channel_id: z.uuid() }).openapi("InstallBot");

const testBody = z
  .object({ text: z.string().min(1).max(4_000), channel_id: z.uuid() })
  .openapi("TestBot");

const testReply = z.object({ reply: z.string(), run: runSchema }).openapi("BotTestReply");

const listRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/bots",
  tags: ["bots"],
  summary: "The bots you can see here",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: workspaceParam },
  responses: {
    200: { description: "Bots", content: { "application/json": { schema: botsSchema } } },
    ...errorResponses(403, 404),
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/bots",
  tags: ["bots"],
  summary: "Make a bot",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: workspaceParam,
    body: { content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: { description: "The bot", content: { "application/json": { schema: botSchema } } },
    ...errorResponses(403, 404, 409, 422),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/bots/{bot}",
  tags: ["bots"],
  summary: "One bot",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: botParam },
  responses: {
    200: { description: "The bot", content: { "application/json": { schema: botSchema } } },
    ...errorResponses(403, 404),
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/api/workspaces/{ws}/bots/{bot}",
  tags: ["bots"],
  summary: "Change a bot",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: botParam,
    body: { content: { "application/json": { schema: patchBody } } },
  },
  responses: {
    200: { description: "The bot", content: { "application/json": { schema: botSchema } } },
    ...errorResponses(403, 404, 409, 422),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/bots/{bot}",
  tags: ["bots"],
  summary: "Take a bot away",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: botParam },
  responses: { 204: { description: "Gone" }, ...errorResponses(403, 404) },
});

const installRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/bots/{bot}/install",
  tags: ["bots"],
  summary: "Put a bot in a channel",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: botParam,
    body: { content: { "application/json": { schema: installBody } } },
  },
  responses: {
    200: { description: "The bot", content: { "application/json": { schema: botSchema } } },
    ...errorResponses(403, 404, 409, 422),
  },
});

const uninstallRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/bots/{bot}/install/{channel}",
  tags: ["bots"],
  summary: "Take a bot out of a channel",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: installParam },
  responses: {
    200: { description: "The bot", content: { "application/json": { schema: botSchema } } },
    ...errorResponses(403, 404),
  },
});

const testRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/bots/{bot}/test",
  tags: ["bots"],
  summary: "Ask a bot something without saying it in the channel",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: botParam,
    body: { content: { "application/json": { schema: testBody } } },
  },
  responses: {
    200: { description: "The reply", content: { "application/json": { schema: testReply } } },
    ...errorResponses(403, 404, 409, 422),
  },
});

const runsRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/bots/{bot}/runs",
  tags: ["bots"],
  summary: "What this bot has done, and what it cost",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: botParam,
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
  },
  responses: {
    200: {
      description: "Runs",
      content: { "application/json": { schema: z.object({ runs: z.array(runSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

function runBody(row: BotRun) {
  return {
    id: row.id,
    trigger: row.trigger,
    trigger_ref: row.triggerRef,
    status: row.status,
    model_id: row.modelId,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cost_usd: Number(row.costUsd),
    started_at: row.startedAt.toISOString(),
    ended_at: row.endedAt ? row.endedAt.toISOString() : null,
    error: row.error,
  };
}

export function registerBots(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const body = async (bot: Bot) => ({
    id: bot.id,
    handle: bot.handle,
    name: bot.name,
    level: bot.level,
    spec: bot.spec,
    owner_id: bot.ownerId,
    visibility: bot.visibility,
    orchestrator: bot.orchestrator,
    budget: bot.budget,
    status: bot.status,
    channels: (await deps.bots.installsOf(bot.id)).map((install) => install.channelId),
    created_at: bot.createdAt.toISOString(),
  });

  /** A bot you may see; a private one that is not yours is not here at all. */
  const visible = async (ws: string, id: string, userId: string) => {
    const bot = await botFor(deps.db.db, ws, id);
    if (bot.visibility === "private" && bot.ownerId !== userId) throw PerchError.notFound("bot");
    return bot;
  };

  /** Changing a bot is its owner's; anybody else needs to answer for the workspace. */
  const mine = async (c: Parameters<typeof actorOf>[0], ws: string, id: string) => {
    const user = currentUser(c);
    const bot = await visible(ws, id, user.id);
    if (bot.ownerId !== user.id) {
      await authorize(c, deps, "bots.admin", { type: "workspace", id: ws });
    }
    return bot;
  };

  app.openapi(listRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "bots.read", { type: "workspace", id: ws });
    const rows = await listBots(deps.db.db, ws, currentUser(c).id);
    return c.json({ bots: await Promise.all(rows.map(body)) }, 200);
  });

  app.openapi(createRouteDef, async (c) => {
    const { ws } = c.req.valid("param");
    const input = c.req.valid("json");
    await authorize(c, deps, "bots.write", { type: "workspace", id: ws });
    // A bot the whole workspace can talk to spends the workspace's money (spec §3.6).
    if (input.visibility === "workspace") {
      await authorize(c, deps, "bots.admin", { type: "workspace", id: ws });
    }
    const bot = await deps.bots.create({
      workspaceId: ws,
      ownerId: currentUser(c).id,
      handle: input.handle,
      name: input.name,
      ...(input.spec ? { spec: input.spec } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      ...(input.orchestrator === undefined ? {} : { orchestrator: input.orchestrator }),
      by: actorOf(c),
    });
    return c.json(await body(bot), 201);
  });

  app.openapi(getRoute, async (c) => {
    const { ws, bot: id } = c.req.valid("param");
    await authorize(c, deps, "bots.read", { type: "workspace", id: ws });
    return c.json(await body(await visible(ws, id, currentUser(c).id)), 200);
  });

  app.openapi(patchRoute, async (c) => {
    const { ws, bot: id } = c.req.valid("param");
    const input = c.req.valid("json");
    await authorize(c, deps, "bots.write", { type: "workspace", id: ws });
    const bot = await mine(c, ws, id);
    if (input.visibility === "workspace" && bot.visibility !== "workspace") {
      await authorize(c, deps, "bots.admin", { type: "workspace", id: ws });
    }
    const updated = await deps.bots.update(bot, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.spec === undefined ? {} : { spec: input.spec }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.orchestrator === undefined ? {} : { orchestrator: input.orchestrator }),
    });
    return c.json(await body(updated), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const { ws, bot: id } = c.req.valid("param");
    await authorize(c, deps, "bots.write", { type: "workspace", id: ws });
    await deps.bots.remove(await mine(c, ws, id));
    return c.body(null, 204);
  });

  app.openapi(installRoute, async (c) => {
    const { ws, bot: id } = c.req.valid("param");
    const input = c.req.valid("json");
    await authorize(c, deps, "bots.write", { type: "workspace", id: ws });
    const bot = await mine(c, ws, id);
    const user = currentUser(c);
    // Putting a bot somewhere is putting it in a channel you are in yourself.
    const channel = await channelFor(deps, ws, input.channel_id, user.id);
    await deps.bots.install(bot, channel, actorOf(c));
    return c.json(await body(bot), 200);
  });

  app.openapi(uninstallRoute, async (c) => {
    const { ws, bot: id, channel: channelId } = c.req.valid("param");
    await authorize(c, deps, "bots.write", { type: "workspace", id: ws });
    const bot = await mine(c, ws, id);
    const channel = await channelFor(deps, ws, channelId, currentUser(c).id);
    await deps.bots.uninstall(bot, channel, actorOf(c));
    return c.json(await body(bot), 200);
  });

  app.openapi(testRoute, async (c) => {
    const { ws, bot: id } = c.req.valid("param");
    const input = c.req.valid("json");
    await authorize(c, deps, "bots.write", { type: "workspace", id: ws });
    const bot = await mine(c, ws, id);
    const channel = await channelFor(deps, ws, input.channel_id, currentUser(c).id);
    const outcome = await deps.bots.test(bot, channel, input.text, actorOf(c));
    return c.json({ reply: outcome.text, run: runBody(outcome.run) }, 200);
  });

  app.openapi(runsRoute, async (c) => {
    const { ws, bot: id } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    await authorize(c, deps, "bots.read", { type: "workspace", id: ws });
    const bot = await visible(ws, id, currentUser(c).id);
    const rows = await listRuns(deps.db.db, bot.id, limit ?? 50);
    return c.json({ runs: rows.map(runBody) }, 200);
  });
}
