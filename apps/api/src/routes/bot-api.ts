/**
 * The Bot API over HTTP (spec §7.3; task 2.19).
 *
 * Slack-shaped paths under `/api/bot/`, a `pbot_…` bearer, and §7.3's scopes on every one. These
 * routes are deliberately not `/api/workspaces/{ws}/…`: a bot's token names its bot, its bot names
 * its workspace, and a bot that had to say which workspace it was in could try to say the wrong one.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { BOT_SCOPES } from "@perch/db";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { type BotCaller, textOf } from "../services/bot-api.ts";
import { storeUpload } from "../services/files.ts";
import { parseBlocks, textBlocks } from "../services/messages.ts";
import { errorResponses } from "./shared.ts";

/** A bot token is a bearer like any other; the `pbot_` prefix is what tells them apart. */
const BOT_BEARER = [{ bearer: [] }];

const okSchema = z.object({ ok: z.literal(true) });

const messageSchema = z
  .object({
    ok: z.literal(true),
    message_id: z.uuid(),
    ts: z.string(),
    channel: z.uuid(),
    thread_ts: z.string().nullable(),
  })
  .openapi("BotMessage");

const conversationSchema = z
  .object({
    id: z.uuid(),
    name: z.string().nullable(),
    type: z.string(),
    topic: z.string().nullable(),
  })
  .openapi("BotConversation");

const historyMessageSchema = z
  .object({
    message_id: z.uuid(),
    ts: z.string(),
    thread_ts: z.string().nullable(),
    author_type: z.enum(["user", "bot", "system"]),
    author_id: z.uuid(),
    text: z.string(),
    blocks: z.array(z.looseObject({ type: z.string() })),
  })
  .openapi("BotHistoryMessage");

const blocksBody = z
  .array(z.looseObject({ type: z.string() }))
  .max(50)
  .optional();

const postMessageRoute = createRoute({
  method: "post",
  path: "/api/bot/chat.postMessage",
  tags: ["bot-api"],
  summary: "Post a message as this bot",
  security: BOT_BEARER,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              channel: z.uuid(),
              text: z.string().min(1).max(40_000).optional(),
              blocks: blocksBody,
              thread_ts: z.uuid().optional(),
            })
            .openapi("BotPostMessage"),
        },
      },
    },
  },
  responses: {
    200: { description: "Posted", content: { "application/json": { schema: messageSchema } } },
    ...errorResponses(403, 404, 409, 422, 429),
  },
});

const updateRoute = createRoute({
  method: "post",
  path: "/api/bot/chat.update",
  tags: ["bot-api"],
  summary: "Rewrite one of this bot's own messages",
  security: BOT_BEARER,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              ts: z.uuid(),
              text: z.string().min(1).max(40_000).optional(),
              blocks: blocksBody,
            })
            .openapi("BotUpdateMessage"),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: messageSchema } } },
    ...errorResponses(403, 404, 409, 422, 429),
  },
});

const deleteRoute = createRoute({
  method: "post",
  path: "/api/bot/chat.delete",
  tags: ["bot-api"],
  summary: "Delete one of this bot's own messages",
  security: BOT_BEARER,
  request: {
    body: {
      content: {
        "application/json": { schema: z.object({ ts: z.uuid() }).openapi("BotDeleteMessage") },
      },
    },
  },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: okSchema } } },
    ...errorResponses(403, 404, 409, 422, 429),
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/api/bot/conversations.list",
  tags: ["bot-api"],
  summary: "The channels this bot is in",
  security: BOT_BEARER,
  responses: {
    200: {
      description: "Channels",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), channels: z.array(conversationSchema) }),
        },
      },
    },
    ...errorResponses(403, 429),
  },
});

const historyRoute = createRoute({
  method: "get",
  path: "/api/bot/conversations.history",
  tags: ["bot-api"],
  summary: "A page of a channel",
  security: BOT_BEARER,
  request: {
    query: z.object({
      channel: z.uuid(),
      oldest: z.uuid().optional(),
      latest: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: {
      description: "Messages, oldest first",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), messages: z.array(historyMessageSchema) }),
        },
      },
    },
    ...errorResponses(403, 404, 409, 422, 429),
  },
});

const repliesRoute = createRoute({
  method: "get",
  path: "/api/bot/conversations.replies",
  tags: ["bot-api"],
  summary: "A thread, root first",
  security: BOT_BEARER,
  request: {
    query: z.object({
      ts: z.uuid(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: {
      description: "The thread",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), messages: z.array(historyMessageSchema) }),
        },
      },
    },
    ...errorResponses(403, 404, 409, 422, 429),
  },
});

const userInfoRoute = createRoute({
  method: "get",
  path: "/api/bot/users.info",
  tags: ["bot-api"],
  summary: "Who somebody is",
  security: BOT_BEARER,
  request: { query: z.object({ user: z.uuid() }) },
  responses: {
    200: {
      description: "The person",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            user: z.object({ id: z.uuid(), name: z.string(), handle: z.string() }),
          }),
        },
      },
    },
    ...errorResponses(403, 404, 422, 429),
  },
});

const toolsCallRoute = createRoute({
  method: "post",
  path: "/api/bot/tools.call",
  tags: ["bot-api"],
  summary: "Call a connection's tool through the MCP gateway",
  security: BOT_BEARER,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              connection_id: z.uuid(),
              tool: z.string().min(1).max(200),
              args: z.record(z.string(), z.unknown()).default({}),
            })
            .openapi("BotToolCall"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "What the tool answered",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), result: z.unknown() }),
        },
      },
    },
    ...errorResponses(403, 404, 409, 422, 429, 502),
  },
});

const filesUploadRoute = createRoute({
  method: "post",
  path: "/api/bot/files.upload",
  tags: ["bot-api"],
  summary: "Upload a file as this bot",
  security: BOT_BEARER,
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.instanceof(File).openapi({ type: "string", format: "binary" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "The stored file",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            file: z
              .object({
                id: z.uuid(),
                name: z.string(),
                mime: z.string(),
                size: z.number(),
                url: z.string(),
              })
              .openapi("BotFile"),
          }),
        },
      },
    },
    ...errorResponses(403, 404, 422, 429),
  },
});

const sessionsOpenRoute = createRoute({
  method: "post",
  path: "/api/bot/sessions.open",
  tags: ["bot-api"],
  summary: "Open an agent session in a project",
  security: BOT_BEARER,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              project: z.uuid(),
              engine: z.string().min(1).max(64).optional(),
              prompt: z.string().min(1).max(100_000).optional(),
            })
            .openapi("BotOpenSession"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "The session",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), session_id: z.uuid(), status: z.string() }),
        },
      },
    },
    ...errorResponses(403, 404, 409, 422, 429, 502),
  },
});

export function registerBotApi(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  /** Every Bot API call: the bearer, the scope it needs, and §7.3's 60-a-minute budget. */
  const enter = async (
    c: { req: { header: (name: string) => string | undefined } },
    scope: (typeof BOT_SCOPES)[number],
  ): Promise<BotCaller> => {
    const header = c.req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!bearer) {
      throw new PerchError("forbidden", "this call needs a bot token", { rule: "bot.token" }, 401);
    }
    const caller = await deps.botApi.caller(bearer);
    deps.botApi.require(caller, scope);
    const budget = deps.botApi.rateLimit(caller);
    if (!budget.ok) {
      throw new PerchError(
        "rate_limited",
        "this bot has made too many calls this minute",
        { retry_after: budget.retryAfter },
        429,
      );
    }
    return caller;
  };

  const blocksOf = (body: { text?: string; blocks?: unknown[] }) => {
    if (body.blocks && body.blocks.length > 0) return parseBlocks(body.blocks);
    if (body.text) return textBlocks(body.text);
    throw PerchError.validation("a message needs text or blocks");
  };

  app.openapi(postMessageRoute, async (c) => {
    const caller = await enter(c, "chat:write");
    const body = c.req.valid("json");
    const message = await deps.botApi.postMessage(caller, {
      channelId: body.channel,
      blocks: blocksOf(body),
      ...(body.thread_ts ? { threadRootId: body.thread_ts } : {}),
    });
    return c.json(
      {
        ok: true as const,
        message_id: message.id,
        ts: message.id,
        channel: message.channelId,
        thread_ts: message.threadRootId,
      },
      200,
    );
  });

  app.openapi(updateRoute, async (c) => {
    const caller = await enter(c, "chat:write");
    const body = c.req.valid("json");
    const message = await deps.botApi.updateMessage(caller, body.ts, blocksOf(body));
    return c.json(
      {
        ok: true as const,
        message_id: message.id,
        ts: message.id,
        channel: message.channelId,
        thread_ts: message.threadRootId,
      },
      200,
    );
  });

  app.openapi(deleteRoute, async (c) => {
    const caller = await enter(c, "chat:write");
    await deps.botApi.deleteMessage(caller, c.req.valid("json").ts);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(listRoute, async (c) => {
    const caller = await enter(c, "channels:read");
    const channels = await deps.botApi.conversations(caller);
    return c.json(
      {
        ok: true as const,
        channels: channels.map((one: (typeof channels)[number]) => ({
          id: one.id,
          name: one.name,
          type: one.type,
          topic: one.topic,
        })),
      },
      200,
    );
  });

  app.openapi(historyRoute, async (c) => {
    const caller = await enter(c, "chat:read");
    const query = c.req.valid("query");
    const messages = await deps.botApi.history(caller, {
      channelId: query.channel,
      ...(query.limit ? { limit: query.limit } : {}),
      ...(query.oldest ? { oldest: query.oldest } : {}),
      ...(query.latest ? { latest: query.latest } : {}),
    });
    return c.json({ ok: true as const, messages: messages.map(historyBody) }, 200);
  });

  app.openapi(repliesRoute, async (c) => {
    const caller = await enter(c, "chat:read");
    const query = c.req.valid("query");
    const messages = await deps.botApi.replies(caller, {
      ts: query.ts,
      ...(query.limit ? { limit: query.limit } : {}),
    });
    return c.json({ ok: true as const, messages: messages.map(historyBody) }, 200);
  });

  app.openapi(userInfoRoute, async (c) => {
    await enter(c, "channels:read");
    const user = await deps.botApi.userInfo(c.req.valid("query").user);
    return c.json({ ok: true as const, user }, 200);
  });

  app.openapi(toolsCallRoute, async (c) => {
    const caller = await enter(c, "tools:call");
    const body = c.req.valid("json");
    const result = await deps.botApi.callTool(caller, {
      connectionId: body.connection_id,
      tool: body.tool,
      args: body.args,
    });
    return c.json({ ok: true as const, result }, 200);
  });

  app.openapi(filesUploadRoute, async (c) => {
    const caller = await enter(c, "files:write");
    const { file } = c.req.valid("form");
    if (!(file instanceof File)) throw PerchError.validation("send a file under `file`");
    const row = await storeUpload(deps, {
      workspaceId: caller.bot.workspaceId,
      uploader: { type: "bot", id: caller.bot.id },
      file,
    });
    return c.json(
      {
        ok: true as const,
        file: {
          id: row.id,
          name: row.name,
          mime: row.mime,
          size: Number(row.size),
          // What a bot puts in a `file` block, and what a person's browser will ask for.
          url: `/api/files/${row.id}`,
        },
      },
      200,
    );
  });

  app.openapi(sessionsOpenRoute, async (c) => {
    const caller = await enter(c, "sessions:open");
    const body = c.req.valid("json");
    const session = await deps.botApi.openSession(caller, {
      projectId: body.project,
      ...(body.engine ? { engine: body.engine } : {}),
      ...(body.prompt ? { prompt: body.prompt } : {}),
    });
    return c.json({ ok: true as const, session_id: session.id, status: session.status }, 200);
  });
}

function historyBody(message: {
  id: string;
  threadRootId: string | null;
  authorType: "user" | "bot" | "system";
  authorId: string;
  blocks: unknown[];
}) {
  return {
    message_id: message.id,
    ts: message.id,
    thread_ts: message.threadRootId,
    author_type: message.authorType,
    author_id: message.authorId,
    text: textOf(message.blocks as Parameters<typeof textOf>[0]),
    blocks: message.blocks as { type: string }[],
  };
}
