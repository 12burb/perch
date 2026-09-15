/**
 * Messages over REST (spec §7.1 `.../channels/{c}/messages?before&after&limit`,
 * `/api/messages/{m}` with PATCH, DELETE and thread; task 2.2).
 *
 * A message is blocks. The composer sends `text` and the api makes the one block it is; a bot sends
 * blocks. Paging is by message id, which is time-ordered (ADR-0025), so `before` is "older than
 * this" and `after` is "newer than this" without a cursor of its own.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Channel, MessageEdit } from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import type { MessageRow } from "../repos/messages.ts";
import { getMessage, getMessageRow, listBookmarks, listPinned } from "../repos/messages.ts";
import { channelFor } from "../services/channels.ts";
import {
  bookmark,
  edit,
  history,
  messages as listChannelMessages,
  parseBlocks,
  pin,
  post,
  read,
  remove,
  textBlocks,
  thread,
} from "../services/messages.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const channelParam = z.object({ ws: z.uuid(), channel: z.uuid() });
const messageParam = z.object({ ws: z.uuid(), message: z.uuid() });
const workspaceParam = z.object({ ws: z.uuid() });

const blockSchema = z.looseObject({ type: z.string() });
/** What the wire calls a block: the discriminator, and whatever else that kind carries. */
type Block = z.infer<typeof blockSchema>;

const messageSchema = z
  .object({
    id: z.uuid(),
    channel_id: z.uuid(),
    thread_root_id: z.uuid().nullable(),
    author_type: z.enum(["user", "bot", "system"]),
    author_id: z.uuid(),
    author_name: z.string().nullable(),
    author_handle: z.string().nullable(),
    blocks: z.array(blockSchema),
    reply_count: z.number().int(),
    pinned: z.boolean(),
    bookmarked: z.boolean(),
    edited_at: z.string().nullable(),
    deleted_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Message");

const messagesSchema = z.object({ messages: z.array(messageSchema) }).openapi("Messages");

const editSchema = z
  .object({
    id: z.uuid(),
    blocks: z.array(blockSchema),
    edited_by_id: z.uuid(),
    at: z.string(),
  })
  .openapi("MessageEdit");

const postBody = z
  .object({
    /** What the composer types. Either this or `blocks`. */
    text: z.string().max(100_000).optional(),
    blocks: z.array(blockSchema).max(50).optional(),
    /** Replying: the message this hangs off, or any message already in that thread. */
    thread_root_id: z.uuid().optional(),
  })
  .openapi("PostMessage");

const patchBody = z
  .object({
    text: z.string().max(100_000).optional(),
    blocks: z.array(blockSchema).max(50).optional(),
    pinned: z.boolean().optional(),
    bookmarked: z.boolean().optional(),
  })
  .openapi("PatchMessage");

const readBody = z.object({ message_id: z.uuid() }).openapi("MarkRead");

const listRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/channels/{channel}/messages",
  tags: ["messages"],
  summary: "A page of a channel, oldest first",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: channelParam,
    query: z.object({
      before: z.uuid().optional(),
      after: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: { description: "Messages", content: { "application/json": { schema: messagesSchema } } },
    ...errorResponses(403, 404),
  },
});

const postRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/channels/{channel}/messages",
  tags: ["messages"],
  summary: "Say something, or reply in a thread",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: channelParam,
    body: { content: { "application/json": { schema: postBody } } },
  },
  responses: {
    201: { description: "The message", content: { "application/json": { schema: messageSchema } } },
    ...errorResponses(403, 404, 409, 422),
  },
});

const threadRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/messages/{message}/thread",
  tags: ["messages"],
  summary: "A thread: its root and everything hanging off it",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: messageParam },
  responses: {
    200: { description: "The thread", content: { "application/json": { schema: messagesSchema } } },
    ...errorResponses(403, 404),
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/api/workspaces/{ws}/messages/{message}",
  tags: ["messages"],
  summary: "Edit it, pin it, or save it for later",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: messageParam,
    body: { content: { "application/json": { schema: patchBody } } },
  },
  responses: {
    200: { description: "The message", content: { "application/json": { schema: messageSchema } } },
    ...errorResponses(403, 404, 409, 422),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/messages/{message}",
  tags: ["messages"],
  summary: "Take it down",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: messageParam },
  responses: { 204: { description: "Gone" }, ...errorResponses(403, 404) },
});

const historyRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/messages/{message}/edits",
  tags: ["messages"],
  summary: "What it said before",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: messageParam },
  responses: {
    200: {
      description: "Edits, newest first",
      content: { "application/json": { schema: z.object({ edits: z.array(editSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const pinsRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/channels/{channel}/pins",
  tags: ["messages"],
  summary: "The pinned messages of a channel",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: channelParam },
  responses: {
    200: { description: "Pinned", content: { "application/json": { schema: messagesSchema } } },
    ...errorResponses(403, 404),
  },
});

const bookmarksRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/bookmarks",
  tags: ["messages"],
  summary: "Everything you saved for later",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: workspaceParam },
  responses: {
    200: { description: "Bookmarks", content: { "application/json": { schema: messagesSchema } } },
    ...errorResponses(403, 404),
  },
});

const readRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/channels/{channel}/read",
  tags: ["messages"],
  summary: "Mark a channel read up to a message",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: channelParam,
    body: { content: { "application/json": { schema: readBody } } },
  },
  responses: { 204: { description: "Marked" }, ...errorResponses(403, 404) },
});

function messageBody(row: MessageRow) {
  return {
    id: row.id,
    channel_id: row.channelId,
    thread_root_id: row.threadRootId,
    author_type: row.authorType,
    author_id: row.authorId,
    author_name: row.authorName,
    author_handle: row.authorHandle,
    blocks: row.blocks as Block[],
    reply_count: row.replyCount,
    pinned: row.pinned,
    bookmarked: row.bookmarked,
    edited_at: row.editedAt ? row.editedAt.toISOString() : null,
    deleted_at: row.deletedAt ? row.deletedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

function editBody(row: MessageEdit) {
  return {
    id: row.id,
    blocks: row.blocks as Block[],
    edited_by_id: row.editedById,
    at: row.createdAt.toISOString(),
  };
}

export function registerMessages(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  /** The channel a message is in, refused the same way the channel itself would be. */
  const channelOfMessage = async (ws: string, messageId: string, userId: string) => {
    const message = await getMessage(deps.db.db, messageId);
    if (!message || message.workspaceId !== ws) throw PerchError.notFound("message");
    const channel: Channel = await channelFor(deps, ws, message.channelId, userId);
    return { message, channel };
  };

  const rowOf = async (id: string, userId: string) => {
    const row = await getMessageRow(deps.db.db, id, userId);
    if (!row) throw PerchError.notFound("message");
    return messageBody(row);
  };

  app.openapi(listRoute, async (c) => {
    const { ws, channel: channelId } = c.req.valid("param");
    const query = c.req.valid("query");
    await authorize(c, deps, "messages.read", { type: "workspace", id: ws });
    const user = currentUser(c);
    const channel = await channelFor(deps, ws, channelId, user.id);
    const rows = await listChannelMessages(deps, channel, user.id, {
      ...(query.before ? { before: query.before } : {}),
      ...(query.after ? { after: query.after } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
    return c.json({ messages: rows.map(messageBody) }, 200);
  });

  app.openapi(postRoute, async (c) => {
    const { ws, channel: channelId } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "messages.write", { type: "workspace", id: ws });
    const user = currentUser(c);
    const channel = await channelFor(deps, ws, channelId, user.id);
    const blocks = body.blocks ? parseBlocks(body.blocks) : textBlocks(body.text ?? "");
    const message = await post(deps, {
      channel,
      userId: user.id,
      blocks,
      ...(body.thread_root_id ? { threadRootId: body.thread_root_id } : {}),
      by: actorOf(c),
    });
    return c.json(await rowOf(message.id, user.id), 201);
  });

  app.openapi(threadRoute, async (c) => {
    const { ws, message: messageId } = c.req.valid("param");
    await authorize(c, deps, "messages.read", { type: "workspace", id: ws });
    const user = currentUser(c);
    const { message, channel } = await channelOfMessage(ws, messageId, user.id);
    const rootId = message.threadRootId ?? message.id;
    const root = await getMessageRow(deps.db.db, rootId, user.id);
    const replies = await thread(deps, channel, rootId, user.id);
    return c.json(
      { messages: [...(root ? [messageBody(root)] : []), ...replies.map(messageBody)] },
      200,
    );
  });

  app.openapi(patchRoute, async (c) => {
    const { ws, message: messageId } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "messages.write", { type: "workspace", id: ws });
    const user = currentUser(c);
    const { message, channel } = await channelOfMessage(ws, messageId, user.id);
    if (body.text !== undefined || body.blocks !== undefined) {
      const blocks = body.blocks ? parseBlocks(body.blocks) : textBlocks(body.text ?? "");
      await edit(deps, { channel, message, userId: user.id, blocks, by: actorOf(c) });
    }
    if (body.pinned !== undefined) {
      await pin(deps, { channel, message, userId: user.id, pinned: body.pinned, by: actorOf(c) });
    }
    if (body.bookmarked !== undefined) {
      await bookmark(deps, { message, userId: user.id, saved: body.bookmarked });
    }
    return c.json(await rowOf(messageId, user.id), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const { ws, message: messageId } = c.req.valid("param");
    await authorize(c, deps, "messages.write", { type: "workspace", id: ws });
    const user = currentUser(c);
    const { message, channel } = await channelOfMessage(ws, messageId, user.id);
    // Taking down somebody else's needs more than writing: ask, but do not refuse the whole call.
    const canModerate = await authorize(c, deps, "messages.moderate", { type: "workspace", id: ws })
      .then(() => true)
      .catch(() => false);
    await remove({ ...deps }, { channel, message, userId: user.id, canModerate, by: actorOf(c) });
    return c.body(null, 204);
  });

  app.openapi(historyRoute, async (c) => {
    const { ws, message: messageId } = c.req.valid("param");
    await authorize(c, deps, "messages.read", { type: "workspace", id: ws });
    const user = currentUser(c);
    const { message } = await channelOfMessage(ws, messageId, user.id);
    const edits = await history(deps, message);
    return c.json({ edits: edits.map(editBody) }, 200);
  });

  app.openapi(pinsRoute, async (c) => {
    const { ws, channel: channelId } = c.req.valid("param");
    await authorize(c, deps, "messages.read", { type: "workspace", id: ws });
    const user = currentUser(c);
    const channel = await channelFor(deps, ws, channelId, user.id);
    const rows = await listPinned(deps.db.db, channel.id, user.id);
    return c.json({ messages: rows.map(messageBody) }, 200);
  });

  app.openapi(bookmarksRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "messages.read", { type: "workspace", id: ws });
    const rows = await listBookmarks(deps.db.db, currentUser(c).id);
    return c.json({ messages: rows.map(messageBody) }, 200);
  });

  app.openapi(readRoute, async (c) => {
    const { ws, channel: channelId } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "messages.read", { type: "workspace", id: ws });
    const user = currentUser(c);
    const channel = await channelFor(deps, ws, channelId, user.id);
    await read(deps, {
      channel,
      userId: user.id,
      messageId: body.message_id,
      by: actorOf(c),
    });
    return c.body(null, 204);
  });
}
