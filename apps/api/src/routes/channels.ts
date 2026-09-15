/**
 * Channels over REST (spec §7.1 `.../channels (+ members)`; task 2.1).
 *
 * The listing is what the Home sidebar draws: every channel this member can see, whether they are
 * in it, and how much they have not read. Messages are task 2.2; what is here is the room itself —
 * making one, naming it, joining it, leaving it, and putting it away.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { CHANNEL_TYPES } from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import type { ChannelWithState, MemberRow } from "../repos/channels.ts";
import {
  channelFor,
  createChannel,
  editChannel,
  joinChannel,
  leaveChannel,
  members as listChannelMembers,
  listChannels,
} from "../services/channels.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const workspaceParam = z.object({ ws: z.uuid() });
const channelParam = z.object({ ws: z.uuid(), channel: z.uuid() });
const memberParam = channelParam.extend({ user: z.uuid() });

const channelSchema = z
  .object({
    id: z.uuid(),
    type: z.enum(CHANNEL_TYPES),
    /** Null for a DM, a group, or an item thread: those are named by who or what is in them. */
    name: z.string().nullable(),
    topic: z.string().nullable(),
    project_id: z.string().nullable(),
    archived: z.boolean(),
    /** Whether the caller is in it, and what is waiting for them there. */
    member: z.boolean(),
    unread: z.number().int(),
    mentions: z.number().int(),
    member_count: z.number().int(),
    created_at: z.string(),
  })
  .openapi("Channel");

const memberSchema = z
  .object({
    member_type: z.enum(["user", "bot"]),
    member_id: z.uuid(),
    role: z.string(),
    name: z.string().nullable(),
    joined_at: z.string(),
  })
  .openapi("ChannelMember");

const membersSchema = z.object({ members: z.array(memberSchema) }).openapi("ChannelMembers");

const createBody = z
  .object({
    type: z.enum(CHANNEL_TYPES).default("public"),
    /** Required for a public or private channel; normalized to what people type after a `#`. */
    name: z.string().min(1).max(80).optional(),
    topic: z.string().max(1000).optional(),
    project_id: z.uuid().optional(),
    /** Who else is in it from the start. The caller is always in it. */
    members: z.array(z.uuid()).max(100).optional(),
  })
  .openapi("CreateChannel");

const updateBody = z
  .object({
    name: z.string().min(1).max(80).optional(),
    topic: z.string().max(1000).optional(),
    archived: z.boolean().optional(),
  })
  .openapi("UpdateChannel");

const joinBody = z
  .object({
    /** Somebody else to add; without it, the caller joins. */
    user_id: z.uuid().optional(),
  })
  .openapi("JoinChannel");

const listRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/channels",
  tags: ["channels"],
  summary: "The channels this member can see, with what is unread in each",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: workspaceParam },
  responses: {
    200: {
      description: "Channels",
      content: {
        "application/json": { schema: z.object({ channels: z.array(channelSchema) }) },
      },
    },
    ...errorResponses(403, 404),
  },
});

const createChannelRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/channels",
  tags: ["channels"],
  summary: "Start a channel, a DM, or a group",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: workspaceParam,
    body: { content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: { description: "The channel", content: { "application/json": { schema: channelSchema } } },
    ...errorResponses(403, 404, 409, 422),
  },
});

const getChannelRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/channels/{channel}",
  tags: ["channels"],
  summary: "One channel",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: channelParam },
  responses: {
    200: { description: "The channel", content: { "application/json": { schema: channelSchema } } },
    ...errorResponses(403, 404),
  },
});

const updateChannelRoute = createRoute({
  method: "patch",
  path: "/api/workspaces/{ws}/channels/{channel}",
  tags: ["channels"],
  summary: "Rename it, set its topic, archive it, or put it back",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: channelParam,
    body: { content: { "application/json": { schema: updateBody } } },
  },
  responses: {
    200: { description: "The channel", content: { "application/json": { schema: channelSchema } } },
    ...errorResponses(403, 404, 409, 422),
  },
});

const membersRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/channels/{channel}/members",
  tags: ["channels"],
  summary: "Who is in a channel",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: channelParam },
  responses: {
    200: { description: "Members", content: { "application/json": { schema: membersSchema } } },
    ...errorResponses(403, 404),
  },
});

const joinRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/channels/{channel}/members",
  tags: ["channels"],
  summary: "Join a channel, or add somebody to it",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: channelParam,
    body: { content: { "application/json": { schema: joinBody } } },
  },
  responses: {
    200: { description: "Members", content: { "application/json": { schema: membersSchema } } },
    ...errorResponses(403, 404, 409),
  },
});

const leaveRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/channels/{channel}/members/{user}",
  tags: ["channels"],
  summary: "Leave a channel, or take somebody out of it",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: memberParam },
  responses: { 204: { description: "Gone" }, ...errorResponses(403, 404) },
});

function channelBody(row: ChannelWithState) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    topic: row.topic,
    project_id: row.projectId,
    archived: row.archivedAt !== null,
    member: row.member,
    unread: row.unread,
    mentions: row.mentions,
    member_count: row.memberCount,
    created_at: row.createdAt.toISOString(),
  };
}

function memberBody(row: MemberRow) {
  return {
    member_type: row.memberType,
    member_id: row.memberId,
    role: row.role,
    name: row.name,
    joined_at: row.joinedAt.toISOString(),
  };
}

export function registerChannels(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  /** One channel with the caller's own state on it, which is the shape every route answers with. */
  const withState = async (ws: string, userId: string, channelId: string) => {
    const rows = await listChannels(deps, ws, userId);
    const row = rows.find((channel) => channel.id === channelId);
    if (!row) throw PerchError.notFound("channel");
    return channelBody(row);
  };

  app.openapi(listRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "channels.read", { type: "workspace", id: ws });
    const rows = await listChannels(deps, ws, currentUser(c).id);
    return c.json({ channels: rows.map(channelBody) }, 200);
  });

  app.openapi(createChannelRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "channels.create", { type: "workspace", id: ws });
    const user = currentUser(c);
    const channel = await createChannel(deps, {
      workspaceId: ws,
      type: body.type,
      ...(body.name ? { name: body.name } : {}),
      ...(body.topic ? { topic: body.topic } : {}),
      ...(body.project_id ? { projectId: body.project_id } : {}),
      ...(body.members ? { members: body.members } : {}),
      userId: user.id,
      by: actorOf(c),
    });
    return c.json(await withState(ws, user.id, channel.id), 201);
  });

  app.openapi(getChannelRoute, async (c) => {
    const { ws, channel: channelId } = c.req.valid("param");
    await authorize(c, deps, "channels.read", { type: "workspace", id: ws });
    const user = currentUser(c);
    await channelFor(deps, ws, channelId, user.id);
    return c.json(await withState(ws, user.id, channelId), 200);
  });

  app.openapi(updateChannelRoute, async (c) => {
    const { ws, channel: channelId } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = currentUser(c);
    // Archiving takes the channel away from everybody in it, so it asks for more than a rename.
    const action = body.archived === undefined ? "channels.update" : "channels.archive";
    await authorize(c, deps, action, { type: "workspace", id: ws });
    const channel = await channelFor(deps, ws, channelId, user.id);
    await editChannel(
      deps,
      channel,
      {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.topic === undefined ? {} : { topic: body.topic }),
        ...(body.archived === undefined ? {} : { archived: body.archived }),
      },
      actorOf(c),
    );
    return c.json(await withState(ws, user.id, channelId), 200);
  });

  app.openapi(membersRoute, async (c) => {
    const { ws, channel: channelId } = c.req.valid("param");
    await authorize(c, deps, "channels.read", { type: "workspace", id: ws });
    const channel = await channelFor(deps, ws, channelId, currentUser(c).id);
    const rows = await listChannelMembers(deps, channel);
    return c.json({ members: rows.map(memberBody) }, 200);
  });

  app.openapi(joinRoute, async (c) => {
    const { ws, channel: channelId } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "channels.update", { type: "workspace", id: ws });
    const user = currentUser(c);
    const channel = await channelFor(deps, ws, channelId, user.id);
    const rows = await joinChannel(deps, channel, {
      userId: user.id,
      ...(body.user_id ? { targetId: body.user_id } : {}),
      by: actorOf(c),
    });
    return c.json({ members: rows.map(memberBody) }, 200);
  });

  app.openapi(leaveRoute, async (c) => {
    const { ws, channel: channelId, user: targetId } = c.req.valid("param");
    await authorize(c, deps, "channels.update", { type: "workspace", id: ws });
    const user = currentUser(c);
    const channel = await channelFor(deps, ws, channelId, user.id);
    const left = await leaveChannel(deps, channel, {
      userId: user.id,
      targetId,
      by: actorOf(c),
    });
    if (!left) throw PerchError.notFound("member");
    return c.body(null, 204);
  });
}
