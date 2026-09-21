/**
 * Bots over REST (spec §7.1 `.../bots (+ install, test, runs, tokens)`; task 2.6). Tokens are the
 * Bot API's, which arrives with the external bots in 2.7.
 *
 * A bot belongs to the person who made it. Everybody in the workspace sees the bots the workspace
 * can talk to; a private one is its owner's alone, and making one everybody can talk to — which
 * spends the workspace's money — is an admin's (ADR-0096).
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { NEST_AGENTS, NEST_DOORS, type NestAgent } from "@perch/bots/nest";
import type { Bot, BotRun, BotToken, BotToolCall } from "@perch/db";
import { BOT_SCOPES, BOT_TOOL_CALL_STATUSES, botBudgetSchema, botSpecSchema } from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { insertBotToken, listBotTokens, revokeBotToken } from "../repos/bot-tokens.ts";
import {
  getBotToolCall,
  lastScheduledRuns,
  listBots,
  listRuns,
  pendingBotToolCalls,
} from "../repos/bots.ts";
import { scheduledJobsFor } from "../repos/jobs.ts";
import { getMessage } from "../repos/messages.ts";
import { botTokenHint, botTokenValue } from "../services/bot-api.ts";
import { botFor, DEFAULT_CATCH_UP_MINUTES } from "../services/bots.ts";
import { channelFor } from "../services/channels.ts";
import { hashToken } from "../services/tokens.ts";
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

const dmSchema = z
  .object({
    channel_id: z.uuid(),
    /** The brain this chat runs on, when the bot lets it be chosen; null means the bot's own. */
    brain: z.string().nullable(),
    /** Whether the person in the chat may choose it at all (spec §5.2). */
    can_pick_brain: z.boolean(),
  })
  .openapi("BotDm");

const pickBrainBody = z
  .object({ brain: z.string().min(1).max(200).nullable() })
  .openapi("PickBotBrain");

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

const dmRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/bots/{bot}/dm",
  tags: ["bots"],
  summary: "Open the chat you have with this bot",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: botParam },
  responses: {
    200: { description: "The chat", content: { "application/json": { schema: dmSchema } } },
    ...errorResponses(403, 404, 409),
  },
});

const pickBrainRoute = createRoute({
  method: "patch",
  path: "/api/workspaces/{ws}/bots/{bot}/install/{channel}",
  tags: ["bots"],
  summary: "Choose the brain this bot runs on here",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: installParam,
    body: { content: { "application/json": { schema: pickBrainBody } } },
  },
  responses: {
    200: { description: "The chat", content: { "application/json": { schema: dmSchema } } },
    ...errorResponses(403, 404, 409, 422),
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

const chainSchema = z
  .object({
    hops: z.array(
      z.object({
        id: z.uuid(),
        hop: z.number().int(),
        from_type: z.enum(["user", "bot", "system"]),
        from_id: z.uuid(),
        from_name: z.string().nullable(),
        to_bot_id: z.uuid(),
        to_name: z.string().nullable(),
        mode: z.enum(["consult", "handoff", "fanout"]),
        status: z.enum(["running", "done", "error", "refused"]),
        cost_usd: z.number(),
        at: z.string(),
      }),
    ),
    cost_usd: z.number(),
    stopped: z.boolean(),
    breaker: z.string().nullable(),
  })
  .openapi("BotChain");

const chainRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/messages/{message}/chain",
  tags: ["bots"],
  summary: "Which bots have answered in this thread, and what it has cost",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: z.object({ ws: z.uuid(), message: z.uuid() }) },
  responses: {
    200: { description: "The chain", content: { "application/json": { schema: chainSchema } } },
    ...errorResponses(403, 404),
  },
});

const scheduleSchema = z
  .object({
    /** Which of the bot's `schedule` triggers this is. */
    index: z.number().int(),
    cron: z.string(),
    /** The zone the expression is read in; UTC when the bot did not say (task 3.5). */
    timezone: z.string(),
    channel: z.string().nullable(),
    prompt: z.string().nullable(),
    /** Whether a firing Perch was down for still runs, and how late is still worth it. */
    catch_up: z.boolean(),
    catch_up_grace_minutes: z.number().int(),
    next_run_at: z.string().nullable(),
    last_run_at: z.string().nullable(),
    last_status: z.string().nullable(),
    last_error: z.string().nullable(),
  })
  .openapi("BotSchedule");

const schedulesRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/bots/{bot}/schedules",
  tags: ["bots"],
  summary: "This bot's schedules: when each next fires, and when it last did",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: botParam },
  responses: {
    200: {
      description: "The schedules",
      content: {
        "application/json": { schema: z.object({ schedules: z.array(scheduleSchema) }) },
      },
    },
    ...errorResponses(403, 404),
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

const tokenSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    hint: z.string(),
    scopes: z.array(z.enum(BOT_SCOPES)),
    last_used_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("BotTokenRow");

const listTokensRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/bots/{bot}/tokens",
  tags: ["bots"],
  summary: "This bot's tokens (hints only; a token is shown once)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: botParam },
  responses: {
    200: {
      description: "Tokens",
      content: { "application/json": { schema: z.object({ tokens: z.array(tokenSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const mintTokenRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/bots/{bot}/tokens",
  tags: ["bots"],
  summary: "Mint a token for this bot; the value is returned exactly once",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: botParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              name: z.string().min(1).max(120),
              scopes: z.array(z.enum(BOT_SCOPES)).min(1),
              /** Days until it stops working; without one it does not expire. */
              expires_in_days: z.number().int().min(1).max(3_650).optional(),
            })
            .openapi("MintBotToken"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "The token, once",
      content: {
        "application/json": {
          schema: z.object({ token: z.string(), row: tokenSchema }).openapi("MintedBotToken"),
        },
      },
    },
    ...errorResponses(403, 404, 422),
  },
});

const revokeTokenRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/bots/{bot}/tokens/{token}",
  tags: ["bots"],
  summary: "Revoke a bot token",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: botParam.extend({ token: z.uuid() }) },
  responses: {
    204: { description: "Revoked" },
    ...errorResponses(403, 404),
  },
});

function tokenBody(row: BotToken) {
  return {
    id: row.id,
    name: row.name,
    hint: row.hint,
    scopes: row.scopes,
    last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

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

const toolCallSchema = z
  .object({
    id: z.uuid(),
    bot_id: z.uuid(),
    channel_id: z.uuid(),
    thread_root_id: z.uuid().nullable(),
    connection_id: z.uuid(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    status: z.enum(BOT_TOOL_CALL_STATUSES),
    requested_by: z.uuid().nullable(),
    decided_by: z.uuid().nullable(),
    decided_at: z.string().nullable(),
    error: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("BotToolCall");

function toolCallBody(row: BotToolCall): z.infer<typeof toolCallSchema> {
  return {
    id: row.id,
    bot_id: row.botId,
    channel_id: row.channelId,
    thread_root_id: row.threadRootId,
    connection_id: row.connectionId,
    tool: row.tool,
    args: row.args,
    status: row.status,
    requested_by: row.requestedBy,
    decided_by: row.decidedBy,
    decided_at: row.decidedAt?.toISOString() ?? null,
    error: row.error,
    created_at: row.createdAt.toISOString(),
  };
}

const toolCallsRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/bot-tool-calls",
  tags: ["bots"],
  summary: "Tool calls waiting on a person (spec §3.5)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: workspaceParam,
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
  },
  responses: {
    200: {
      description: "What is still pending",
      content: {
        "application/json": { schema: z.object({ calls: z.array(toolCallSchema) }) },
      },
    },
    ...errorResponses(403, 404),
  },
});

const decideToolCallRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/bot-tool-calls/{call}/decide",
  tags: ["bots"],
  summary: "Approve or deny a bot's tool call; approving runs it and posts the result",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: z.object({ ws: z.uuid(), call: z.uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ decision: z.enum(["approved", "denied"]) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "The call, as it stands after the decision",
      content: { "application/json": { schema: toolCallSchema } },
    },
    ...errorResponses(403, 404, 409),
  },
});

const nestAgentSchema = z
  .object({
    handle: z.string(),
    name: z.string(),
    blurb: z.string(),
    door: z.enum(NEST_DOORS),
    orchestrator: z.boolean(),
    connections: z.array(z.string()),
    /** Whether this workspace already has a bot by that handle. */
    installed: z.boolean(),
  })
  .openapi("NestAgent");

const nestRosterRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/nest",
  tags: ["bots"],
  summary: "The Nest roster, and which of them this workspace already has (spec §5.3)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: workspaceParam },
  responses: {
    200: {
      description: "Who is in the Nest",
      content: {
        "application/json": { schema: z.object({ agents: z.array(nestAgentSchema) }) },
      },
    },
    ...errorResponses(403, 404),
  },
});

const installedNestSchema = z
  .object({
    handle: z.string(),
    name: z.string(),
    bot_id: z.uuid(),
    door: z.enum(NEST_DOORS),
    /** Minted once for an agent that joins over the Bot API; never readable again. */
    token: z.string().optional(),
    connections: z.array(z.string()),
  })
  .openapi("InstalledNestAgent");

const nestInstallRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/nest",
  tags: ["bots"],
  summary: "Install the Nest agents that are missing (spec §5.3)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: workspaceParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              /** Some of the roster; the whole Nest when it is left out. */
              handles: z.array(z.string().min(1).max(64)).max(20).optional(),
            })
            .openapi("InstallNest"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "What was installed, and who was already here",
      content: {
        "application/json": {
          schema: z.object({
            installed: z.array(installedNestSchema),
            already: z.array(z.string()),
          }),
        },
      },
    },
    ...errorResponses(403, 404, 409),
  },
});

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

  /** A chat with a bot, as the client needs it: where it is, and what it is running on. */
  const dmBody = async (bot: Bot, channelId: string) => {
    const install = (await deps.bots.installsOf(bot.id)).find((row) => row.channelId === channelId);
    return {
      channel_id: channelId,
      brain: install?.scopes.brain ?? null,
      can_pick_brain: bot.spec.brain?.pick === true,
    };
  };

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

  app.openapi(dmRoute, async (c) => {
    const { ws, bot: id } = c.req.valid("param");
    // Talking to a bot is reading it: a chat of your own is not installing it anywhere shared.
    await authorize(c, deps, "bots.read", { type: "workspace", id: ws });
    const user = currentUser(c);
    const bot = await visible(ws, id, user.id);
    if (bot.status === "disabled") throw PerchError.conflict("this bot is switched off");
    const channel = await deps.bots.dm(bot, user.id, actorOf(c));
    return c.json(await dmBody(bot, channel.id), 200);
  });

  app.openapi(pickBrainRoute, async (c) => {
    const { ws, bot: id, channel: channelId } = c.req.valid("param");
    const input = c.req.valid("json");
    await authorize(c, deps, "bots.read", { type: "workspace", id: ws });
    const user = currentUser(c);
    const bot = await visible(ws, id, user.id);
    const channel = await channelFor(deps, ws, channelId, user.id);
    await deps.bots.pickBrain(bot, channel, input.brain, actorOf(c));
    return c.json(await dmBody(bot, channel.id), 200);
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

  app.openapi(chainRoute, async (c) => {
    const { ws, message: messageId } = c.req.valid("param");
    // Reading a thread's chain is reading the thread: the channel's own rule decides.
    await authorize(c, deps, "messages.read", { type: "workspace", id: ws });
    const user = currentUser(c);
    const message = await getMessage(deps.db.db, messageId);
    if (!message || message.workspaceId !== ws) throw PerchError.notFound("message");
    await channelFor(deps, ws, message.channelId, user.id);
    const view = await deps.bots.chain(message.threadRootId ?? message.id);
    return c.json(
      {
        hops: view.hops.map((hop) => ({
          id: hop.id,
          hop: hop.hop,
          from_type: hop.fromType,
          from_id: hop.fromId,
          from_name: hop.fromName,
          to_bot_id: hop.toBotId,
          to_name: hop.toName,
          mode: hop.mode,
          status: hop.status,
          cost_usd: hop.costUsd,
          at: hop.at,
        })),
        cost_usd: view.costUsd,
        stopped: view.stopped,
        breaker: view.breaker,
      },
      200,
    );
  });

  app.openapi(schedulesRoute, async (c) => {
    const { ws, bot: id } = c.req.valid("param");
    await authorize(c, deps, "bots.read", { type: "workspace", id: ws });
    const bot = await visible(ws, id, currentUser(c).id);
    const [jobs, runs] = await Promise.all([
      scheduledJobsFor(deps.db.db, bot.id),
      lastScheduledRuns(deps.db.db, bot.id),
    ]);
    const byKey = new Map(jobs.map((job) => [job.key, job]));
    const schedules = (bot.spec.triggers ?? [])
      .map((trigger, index) => ({ trigger, index }))
      .filter(({ trigger }) => trigger.on === "schedule" && typeof trigger.cron === "string")
      // The queue's keys count the schedules, not every trigger, so the index is the position
      // among the scheduled ones — the same one `reschedule` used.
      .map(({ trigger }, at) => {
        const job = byKey.get(`bot:${bot.id}:${at}`);
        const last = runs.get(trigger.cron ?? "");
        return {
          index: at,
          cron: trigger.cron ?? "",
          timezone: job?.timezone ?? bot.spec.timezone ?? "UTC",
          channel: trigger.channel ?? null,
          prompt: trigger.prompt ?? null,
          catch_up: trigger.catchUp !== false,
          catch_up_grace_minutes: trigger.catchUpGraceMinutes ?? DEFAULT_CATCH_UP_MINUTES,
          next_run_at: job?.runAt.toISOString() ?? null,
          last_run_at: last?.at.toISOString() ?? null,
          last_status: last?.status ?? null,
          last_error: last?.error ?? null,
        };
      });
    return c.json({ schedules }, 200);
  });

  app.openapi(runsRoute, async (c) => {
    const { ws, bot: id } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    await authorize(c, deps, "bots.read", { type: "workspace", id: ws });
    const bot = await visible(ws, id, currentUser(c).id);
    const rows = await listRuns(deps.db.db, bot.id, limit ?? 50);
    return c.json({ runs: rows.map(runBody) }, 200);
  });

  app.openapi(listTokensRoute, async (c) => {
    const { ws, bot: id } = c.req.valid("param");
    await authorize(c, deps, "bots.write", { type: "workspace", id: ws });
    // A token acts as the bot, so it is the owner's to mint — or an admin's (ADR-0112, revised).
    const bot = await mine(c, ws, id);
    const rows = await listBotTokens(deps.db.db, bot.id);
    return c.json({ tokens: rows.map(tokenBody) }, 200);
  });

  app.openapi(mintTokenRoute, async (c) => {
    const { ws, bot: id } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "bots.write", { type: "workspace", id: ws });
    // A token acts as the bot, so it is the owner's to mint — or an admin's (ADR-0112, revised).
    const bot = await mine(c, ws, id);
    const token = botTokenValue();
    const row = await insertBotToken(deps.db.db, {
      botId: bot.id,
      workspaceId: bot.workspaceId,
      name: body.name.trim(),
      tokenHash: hashToken(token),
      hint: botTokenHint(token),
      scopes: body.scopes,
      createdBy: currentUser(c).id,
      ...(body.expires_in_days
        ? { expiresAt: new Date(Date.now() + body.expires_in_days * 86_400_000) }
        : {}),
    });
    return c.json({ token, row: tokenBody(row) }, 201);
  });

  app.openapi(revokeTokenRoute, async (c) => {
    const { ws, bot: id, token } = c.req.valid("param");
    await authorize(c, deps, "bots.write", { type: "workspace", id: ws });
    // A token acts as the bot, so it is the owner's to mint — or an admin's (ADR-0112, revised).
    const bot = await mine(c, ws, id);
    if (!(await revokeBotToken(deps.db.db, bot.id, token))) throw PerchError.notFound("token");
    return c.body(null, 204);
  });

  app.openapi(toolCallsRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    await authorize(c, deps, "bots.read", { type: "workspace", id: ws });
    const rows = await pendingBotToolCalls(deps.db.db, ws, limit ?? 50);
    return c.json({ calls: rows.map(toolCallBody) }, 200);
  });

  app.openapi(decideToolCallRoute, async (c) => {
    const { ws, call } = c.req.valid("param");
    const { decision } = c.req.valid("json");
    // Answering is using the connection, so it is the connection's permission, not the bot's.
    await authorize(c, deps, "connections.write", { type: "workspace", id: ws });
    const row = await getBotToolCall(deps.db.db, call);
    if (!row || row.workspaceId !== ws) throw PerchError.notFound("tool call");
    // Being in the channel is what allows it: the question was asked there, in front of everybody
    // who can see it, and somebody who cannot see the thread cannot answer for it.
    await channelFor(deps, ws, row.channelId, currentUser(c).id);
    const answered = await deps.bots.decideToolCall({
      callId: row.id,
      decision,
      userId: currentUser(c).id,
      by: actorOf(c),
    });
    return c.json(toolCallBody(answered), 200);
  });

  app.openapi(nestRosterRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "bots.read", { type: "workspace", id: ws });
    const here = await listBots(deps.db.db, ws, currentUser(c).id);
    const handles = new Set(here.map((row) => row.handle));
    return c.json(
      {
        agents: NEST_AGENTS.map((one: NestAgent) => ({
          handle: one.handle,
          name: one.name,
          blurb: one.blurb,
          door: one.door,
          orchestrator: one.orchestrator === true,
          connections: one.connections ?? [],
          installed: handles.has(one.handle),
        })),
      },
      200,
    );
  });

  app.openapi(nestInstallRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    // A Nest agent is visible to the whole workspace and spends its money: an admin's to add.
    await authorize(c, deps, "bots.admin", { type: "workspace", id: ws });
    const result = await deps.nest.install({
      workspaceId: ws,
      ownerId: currentUser(c).id,
      ...(body.handles ? { handles: body.handles } : {}),
      by: actorOf(c),
    });
    return c.json(
      {
        installed: result.installed.map((one) => ({
          handle: one.handle,
          name: one.name,
          bot_id: one.botId,
          door: one.door,
          ...(one.token ? { token: one.token } : {}),
          connections: one.connections,
        })),
        already: result.already,
      },
      201,
    );
  });
}
