/**
 * channels, channel_members and read_state (spec §6; task 2.1). Every query is scoped to a
 * workspace, and every listing to what one member may see: a public channel is visible to the
 * workspace, everything else only to the people in it.
 */
import { type Channel, type ChannelMember, type ChannelType, type Db, schema } from "@perch/db";
import { and, asc, count, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

const { channels, channelMembers, messages, readState, users } = schema;

export type ChannelWithState = Channel & {
  /** Whether the caller is in it, how much they have not read, and how much of it named them. */
  member: boolean;
  unread: number;
  mentions: number;
  memberCount: number;
};

/** The channel ids a member belongs to, in one query. */
export async function memberChannelIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .where(and(eq(channelMembers.memberType, "user"), eq(channelMembers.memberId, userId)));
  return rows.map((row) => row.channelId);
}

/**
 * What one member sees in a workspace: every public channel, plus the private ones, DMs, groups
 * and item threads they are in. Archived channels are included; the caller decides what to show.
 */
export async function listChannelsFor(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<ChannelWithState[]> {
  const mine = await memberChannelIds(db, userId);
  const visible = mine.length
    ? or(eq(channels.type, "public"), inArray(channels.id, mine))
    : eq(channels.type, "public");
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), visible))
    .orderBy(asc(channels.name), asc(channels.createdAt));
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const counts = await db
    .select({ channelId: channelMembers.channelId, total: count() })
    .from(channelMembers)
    .where(inArray(channelMembers.channelId, ids))
    .groupBy(channelMembers.channelId);
  const memberCounts = new Map(counts.map((row) => [row.channelId, Number(row.total)]));
  const unread = await unreadCounts(db, userId, ids);
  const mentions = await mentionCounts(db, userId, ids);
  const mineSet = new Set(mine);
  return rows.map((row) => ({
    ...row,
    member: mineSet.has(row.id),
    unread: unread.get(row.id) ?? 0,
    mentions: mentions.get(row.id) ?? 0,
    memberCount: memberCounts.get(row.id) ?? 0,
  }));
}

/**
 * How many messages in each channel arrived after the caller last read it — their own and deleted
 * ones never count. A channel with no read_state row is unread in full, which is what a channel
 * somebody was just added to should look like.
 */
export async function unreadCounts(
  db: Db,
  userId: string,
  channelIds: string[],
): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  // The read mark is a message id, and ids are UUIDv7 (ADR-0025): time-ordered, so "newer than the
  // mark" is `id > mark.id` — which, unlike created_at, cannot tie between two messages written in
  // the same instant. No mark at all means the whole channel is unread.
  const mark = alias(messages, "read_mark");
  const rows = await db
    .select({ channelId: messages.channelId, total: count() })
    .from(messages)
    .leftJoin(
      readState,
      and(eq(readState.channelId, messages.channelId), eq(readState.userId, userId)),
    )
    .leftJoin(mark, eq(mark.id, readState.lastReadMessageId))
    .where(
      and(
        inArray(messages.channelId, channelIds),
        isNull(messages.deletedAt),
        // A thread's replies are not in the channel's flow, so they cannot be read by reading it;
        // counting them would leave an unread nobody can clear (task 2.2).
        isNull(messages.threadRootId),
        ne(messages.authorId, userId),
        or(isNull(mark.id), gt(messages.id, mark.id)),
      ),
    )
    .groupBy(messages.channelId);
  return new Map(rows.map((row) => [row.channelId, Number(row.total)]));
}

/** How many unread messages named the caller (task 2.2): the weight a mention carries. */
export async function mentionCounts(
  db: Db,
  userId: string,
  channelIds: string[],
): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db
    .select({ channelId: readState.channelId, mentions: readState.mentionCount })
    .from(readState)
    .where(and(eq(readState.userId, userId), inArray(readState.channelId, channelIds)));
  return new Map(rows.map((row) => [row.channelId, row.mentions]));
}

export async function getChannel(db: Db, id: string): Promise<Channel | null> {
  const [row] = await db.select().from(channels).where(eq(channels.id, id)).limit(1);
  return row ?? null;
}

export async function findChannelByName(
  db: Db,
  workspaceId: string,
  name: string,
): Promise<Channel | null> {
  const [row] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, name)))
    .limit(1);
  return row ?? null;
}

export async function insertChannel(
  db: Db,
  values: {
    workspaceId: string;
    type: ChannelType;
    name: string | null;
    topic: string | null;
    projectId?: string | null;
  },
): Promise<Channel> {
  const [row] = await db.insert(channels).values(values).returning();
  if (!row) throw new Error("channel insert returned no row");
  return row;
}

export async function updateChannel(
  db: Db,
  id: string,
  values: Partial<Pick<Channel, "name" | "topic" | "archivedAt">>,
): Promise<Channel | null> {
  const [row] = await db
    .update(channels)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(channels.id, id))
    .returning();
  return row ?? null;
}

export type MemberRow = ChannelMember & { name: string | null; email: string | null };

/** Who is in a channel: people with their names, bots by id until task 2.6 gives them one. */
export async function listMembers(db: Db, channelId: string): Promise<MemberRow[]> {
  const rows = await db
    .select({ member: channelMembers, name: users.name, email: users.email })
    .from(channelMembers)
    .leftJoin(
      users,
      and(eq(channelMembers.memberType, "user"), eq(channelMembers.memberId, users.id)),
    )
    .where(eq(channelMembers.channelId, channelId))
    .orderBy(asc(channelMembers.joinedAt));
  return rows.map((row) => ({ ...row.member, name: row.name, email: row.email }));
}

export async function findMember(
  db: Db,
  channelId: string,
  memberType: "user" | "bot",
  memberId: string,
): Promise<ChannelMember | null> {
  const [row] = await db
    .select()
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.memberType, memberType),
        eq(channelMembers.memberId, memberId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Adding somebody already in the channel is not an error: the row stays as it was. */
export async function addMember(
  db: Db,
  values: { channelId: string; memberType: "user" | "bot"; memberId: string; role?: string },
): Promise<ChannelMember> {
  const existing = await findMember(db, values.channelId, values.memberType, values.memberId);
  if (existing) return existing;
  const [row] = await db
    .insert(channelMembers)
    .values({ ...values, role: values.role ?? "member" })
    .returning();
  if (!row) throw new Error("channel member insert returned no row");
  return row;
}

export async function removeMember(
  db: Db,
  channelId: string,
  memberType: "user" | "bot",
  memberId: string,
): Promise<boolean> {
  const removed = await db
    .delete(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.memberType, memberType),
        eq(channelMembers.memberId, memberId),
      ),
    )
    .returning({ id: channelMembers.id });
  return removed.length > 0;
}
