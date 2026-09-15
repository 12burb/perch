/**
 * Channels (spec §5.2, §6; task 2.1). A workspace is a place to talk: public channels anyone can
 * find and join, private ones you have to be added to, DMs and groups that are named by who is in
 * them, and item threads that hang off a work item.
 *
 * Pure functions over `Db` and `Bus` (spec §9.1). Every change publishes a bus event, which is what
 * fans out over the WebSocket and writes the audit line; features never write the audit log.
 */
import type { Bus } from "@perch/bus";
import type { Channel, ChannelType, Db } from "@perch/db";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import {
  addMember,
  type ChannelWithState,
  findChannelByName,
  findMember,
  getChannel,
  insertChannel,
  listChannelsFor,
  listMembers,
  type MemberRow,
  removeMember,
  updateChannel,
} from "../repos/channels.ts";

export type ChannelDeps = { db: { db: Db }; bus: Bus };

/**
 * A channel name is what people type after a `#`: lower case, no spaces, no punctuation beyond a
 * dash or an underscore. Slack's rules, because everybody already knows them.
 */
export function normalizeChannelName(raw: string): string {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (name.length < 1 || name.length > 80) {
    throw PerchError.validation("a channel name is 1 to 80 characters of letters, digits and -");
  }
  return name;
}

/** Whether a channel is one a member may open at all (spec §5.2: bots and people see the same). */
export async function visibleTo(
  deps: ChannelDeps,
  channel: Channel,
  userId: string,
): Promise<boolean> {
  if (channel.type === "public") return true;
  return (await findMember(deps.db.db, channel.id, "user", userId)) !== null;
}

export async function listChannels(
  deps: ChannelDeps,
  workspaceId: string,
  userId: string,
): Promise<ChannelWithState[]> {
  return listChannelsFor(deps.db.db, workspaceId, userId);
}

/** One channel, refused as "not found" when the caller may not see it — a private name is private. */
export async function channelFor(
  deps: ChannelDeps,
  workspaceId: string,
  channelId: string,
  userId: string,
): Promise<Channel> {
  const channel = await getChannel(deps.db.db, channelId);
  if (!channel || channel.workspaceId !== workspaceId) throw PerchError.notFound("channel");
  if (!(await visibleTo(deps, channel, userId))) throw PerchError.notFound("channel");
  return channel;
}

export type CreateChannelInput = {
  workspaceId: string;
  type: ChannelType;
  name?: string | undefined;
  topic?: string | undefined;
  projectId?: string | undefined;
  /** Who is in it from the start, besides the person creating it. */
  members?: readonly string[] | undefined;
  userId: string;
  by: ActorContext;
};

/**
 * Creating a channel puts the creator in it. A public or private channel has a name; a DM, a group
 * or an item thread is named by its members or its item, so its name stays null and the client
 * draws the people in it.
 */
export async function createChannel(
  deps: ChannelDeps,
  input: CreateChannelInput,
): Promise<Channel> {
  const named = input.type === "public" || input.type === "private";
  if (named && !input.name?.trim()) {
    throw PerchError.validation("a public or private channel needs a name");
  }
  const name = named ? normalizeChannelName(input.name ?? "") : null;
  if (name) {
    const taken = await findChannelByName(deps.db.db, input.workspaceId, name);
    if (taken) throw PerchError.conflict(`#${name} already exists`);
  }
  const channel = await insertChannel(deps.db.db, {
    workspaceId: input.workspaceId,
    type: input.type,
    name,
    topic: input.topic?.trim() || null,
    projectId: input.projectId ?? null,
  });
  const people = new Set<string>([input.userId, ...(input.members ?? [])]);
  for (const userId of people) {
    await addMember(deps.db.db, {
      channelId: channel.id,
      memberType: "user",
      memberId: userId,
      role: userId === input.userId ? "owner" : "member",
    });
  }
  await deps.bus.publish(
    "channel.created",
    { workspaceId: input.workspaceId, channelId: channel.id, type: channel.type },
    input.by,
  );
  return channel;
}

export type UpdateChannelInput = {
  topic?: string | undefined;
  name?: string | undefined;
  archived?: boolean | undefined;
};

/** Renaming, re-topicking, archiving and unarchiving, all as one PATCH (spec §7.1). */
export async function editChannel(
  deps: ChannelDeps,
  channel: Channel,
  input: UpdateChannelInput,
  by: ActorContext,
): Promise<Channel> {
  const values: Partial<Pick<Channel, "name" | "topic" | "archivedAt">> = {};
  const changes: string[] = [];
  if (input.name !== undefined) {
    if (channel.type !== "public" && channel.type !== "private") {
      throw PerchError.conflict("only a public or private channel has a name");
    }
    const name = normalizeChannelName(input.name);
    if (name !== channel.name) {
      const taken = await findChannelByName(deps.db.db, channel.workspaceId, name);
      if (taken && taken.id !== channel.id) throw PerchError.conflict(`#${name} already exists`);
      values.name = name;
      changes.push("name");
    }
  }
  if (input.topic !== undefined) {
    values.topic = input.topic.trim() || null;
    changes.push("topic");
  }
  if (input.archived !== undefined) {
    const archivedAt = input.archived ? new Date() : null;
    if (Boolean(channel.archivedAt) !== input.archived) {
      values.archivedAt = archivedAt;
      changes.push("archived");
    }
  }
  if (changes.length === 0) return channel;
  const row = await updateChannel(deps.db.db, channel.id, values);
  if (!row) throw PerchError.notFound("channel");
  // Archiving is its own event, because it takes the channel away from everybody in it; coming
  // back out of the archive is an ordinary update.
  if (row.archivedAt && changes.includes("archived")) {
    await deps.bus.publish(
      "channel.archived",
      { workspaceId: row.workspaceId, channelId: row.id },
      by,
    );
    return row;
  }
  await deps.bus.publish(
    "channel.updated",
    { workspaceId: row.workspaceId, channelId: row.id, changes },
    by,
  );
  return row;
}

export async function members(deps: ChannelDeps, channel: Channel): Promise<MemberRow[]> {
  return listMembers(deps.db.db, channel.id);
}

/**
 * Joining, and adding somebody else. A public channel is open to every member of the workspace;
 * anything else has to be opened from the inside, by somebody already in it.
 */
export async function joinChannel(
  deps: ChannelDeps,
  channel: Channel,
  input: { userId: string; targetId?: string | undefined; by: ActorContext },
): Promise<MemberRow[]> {
  if (channel.archivedAt) throw PerchError.conflict("this channel is archived");
  const targetId = input.targetId ?? input.userId;
  if (targetId !== input.userId || channel.type !== "public") {
    const inside = await findMember(deps.db.db, channel.id, "user", input.userId);
    if (!inside) throw PerchError.notFound("channel");
  }
  await addMember(deps.db.db, {
    channelId: channel.id,
    memberType: "user",
    memberId: targetId,
  });
  await deps.bus.publish(
    "channel.updated",
    { workspaceId: channel.workspaceId, channelId: channel.id, changes: ["members"] },
    input.by,
  );
  return listMembers(deps.db.db, channel.id);
}

/**
 * Leaving, and removing somebody else. Anyone may leave anything; removing another person needs
 * you to be in the channel, which is the same rule as adding one.
 */
export async function leaveChannel(
  deps: ChannelDeps,
  channel: Channel,
  input: { userId: string; targetId?: string | undefined; by: ActorContext },
): Promise<boolean> {
  const targetId = input.targetId ?? input.userId;
  if (targetId !== input.userId) {
    const inside = await findMember(deps.db.db, channel.id, "user", input.userId);
    if (!inside) throw PerchError.notFound("channel");
  }
  const left = await removeMember(deps.db.db, channel.id, "user", targetId);
  if (!left) return false;
  await deps.bus.publish(
    "channel.updated",
    { workspaceId: channel.workspaceId, channelId: channel.id, changes: ["members"] },
    input.by,
  );
  return true;
}
