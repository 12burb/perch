/**
 * messages, message_edits, message_reactions, pins, bookmarks and read_state (spec §6; tasks 2.2
 * and 2.3). Paging is by id: ids are UUIDv7 (ADR-0025), so `before` and `after` are id comparisons
 * and a page cannot slip when two messages land in the same instant.
 */
import type { Db, Message, MessageBlock, MessageEdit } from "@perch/db";
import { schema } from "@perch/db";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

const { messages, messageEdits, messageReactions, pins, bookmarks, readState, users } = schema;

/** One emoji on one message: how many put it there, and whether the caller is one of them. */
export type ReactionSummary = { emoji: string; count: number; mine: boolean };

export type MessageRow = Message & {
  /** The author's name and handle when they are a person; null for a bot until task 2.6. */
  authorName: string | null;
  authorHandle: string | null;
  pinned: boolean;
  bookmarked: boolean;
  reactions: ReactionSummary[];
};

type ListOptions = {
  /** Only the messages before this id (older), or after it (newer). */
  before?: string | undefined;
  after?: string | undefined;
  limit?: number | undefined;
  /** A thread's replies rather than the channel's own messages. */
  threadRootId?: string | undefined;
};

function decorate(
  rows: { message: Message; name: string | null; handle: string | null }[],
  pinnedIds: Set<string>,
  bookmarkedIds: Set<string>,
  reactions: Map<string, ReactionSummary[]>,
): MessageRow[] {
  return rows.map((row) => ({
    ...row.message,
    authorName: row.name,
    authorHandle: row.handle,
    pinned: pinnedIds.has(row.message.id),
    bookmarked: bookmarkedIds.has(row.message.id),
    reactions: reactions.get(row.message.id) ?? [],
  }));
}

/**
 * A page of a channel, oldest first. Without `threadRootId` this is the channel itself: replies
 * live in their thread and are not repeated in the main flow (spec §5.2).
 */
export async function listMessages(
  db: Db,
  channelId: string,
  userId: string,
  options: ListOptions = {},
): Promise<MessageRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const where = [eq(messages.channelId, channelId)];
  if (options.threadRootId) where.push(eq(messages.threadRootId, options.threadRootId));
  else where.push(isNull(messages.threadRootId));
  if (options.before) where.push(lt(messages.id, options.before));
  if (options.after) where.push(gt(messages.id, options.after));

  // `before` reads backwards from the newest, which is what scrolling up asks for; the page is
  // turned around again so a caller always gets oldest first.
  const backwards = Boolean(options.before) || !options.after;
  const rows = await db
    .select({ message: messages, name: users.name, handle: users.handle })
    .from(messages)
    .leftJoin(users, and(eq(messages.authorType, "user"), eq(messages.authorId, users.id)))
    .where(and(...where))
    .orderBy(backwards ? desc(messages.id) : asc(messages.id))
    .limit(limit);
  const page = backwards ? rows.reverse() : rows;
  const ids = page.map((row) => row.message.id);
  return decorate(
    page,
    await pinnedIn(db, ids),
    await bookmarkedBy(db, userId, ids),
    await reactionsOn(db, ids, userId),
  );
}

async function pinnedIn(db: Db, messageIds: string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await db
    .select({ messageId: pins.messageId })
    .from(pins)
    .where(inArray(pins.messageId, messageIds));
  return new Set(rows.map((row) => row.messageId));
}

async function bookmarkedBy(db: Db, userId: string, messageIds: string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await db
    .select({ messageId: bookmarks.messageId })
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), inArray(bookmarks.messageId, messageIds)));
  return new Set(rows.map((row) => row.messageId));
}

/**
 * The reactions on a page of messages (task 2.3), grouped the way they are shown: one pill per
 * emoji with its count, in the order they were first put there. `mine` is what makes the pill a
 * toggle rather than a tally.
 */
export async function reactionsOn(
  db: Db,
  messageIds: string[],
  userId: string,
): Promise<Map<string, ReactionSummary[]>> {
  const out = new Map<string, ReactionSummary[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({
      messageId: messageReactions.messageId,
      emoji: messageReactions.emoji,
      count: sql<number>`count(*)::int`,
      mine: sql<boolean>`bool_or(${messageReactions.memberType} = 'user' and ${
        messageReactions.memberId
      } = ${sql.param(userId, messageReactions.memberId)})`,
    })
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, messageIds))
    .groupBy(messageReactions.messageId, messageReactions.emoji)
    // uuid has no min() in Postgres, so "first put there" is the earliest of the group.
    .orderBy(sql`min(${messageReactions.createdAt}) asc`, asc(messageReactions.emoji));
  for (const row of rows) {
    const pills = out.get(row.messageId) ?? [];
    pills.push({ emoji: row.emoji, count: Number(row.count), mine: Boolean(row.mine) });
    out.set(row.messageId, pills);
  }
  return out;
}

/** True when this put a reaction there; false when it was already theirs. */
export async function addReaction(
  db: Db,
  values: { messageId: string; memberType: "user" | "bot"; memberId: string; emoji: string },
): Promise<boolean> {
  const rows = await db
    .insert(messageReactions)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: messageReactions.id });
  return rows.length > 0;
}

/** True when this took one away; false when there was nothing of theirs to take. */
export async function removeReaction(
  db: Db,
  values: { messageId: string; memberType: "user" | "bot"; memberId: string; emoji: string },
): Promise<boolean> {
  const rows = await db
    .delete(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, values.messageId),
        eq(messageReactions.memberType, values.memberType),
        eq(messageReactions.memberId, values.memberId),
        eq(messageReactions.emoji, values.emoji),
      ),
    )
    .returning({ id: messageReactions.id });
  return rows.length > 0;
}

export async function getMessage(db: Db, id: string): Promise<Message | null> {
  const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  return row ?? null;
}

/** One message with the same decoration a listing gives, for a route that answers with just it. */
export async function getMessageRow(
  db: Db,
  id: string,
  userId: string,
): Promise<MessageRow | null> {
  const [row] = await db
    .select({ message: messages, name: users.name, handle: users.handle })
    .from(messages)
    .leftJoin(users, and(eq(messages.authorType, "user"), eq(messages.authorId, users.id)))
    .where(eq(messages.id, id))
    .limit(1);
  if (!row) return null;
  const [decorated] = decorate(
    [row],
    await pinnedIn(db, [id]),
    await bookmarkedBy(db, userId, [id]),
    await reactionsOn(db, [id], userId),
  );
  return decorated ?? null;
}

export async function insertMessage(
  db: Db,
  values: {
    workspaceId: string;
    channelId: string;
    threadRootId?: string | null;
    authorType: "user" | "bot" | "system";
    authorId: string;
    blocks: MessageBlock[];
  },
): Promise<Message> {
  const [row] = await db.insert(messages).values(values).returning();
  if (!row) throw new Error("message insert returned no row");
  // A thread's root carries the count the channel shows beside it.
  if (values.threadRootId) {
    await db
      .update(messages)
      .set({ replyCount: sql`${messages.replyCount} + 1`, updatedAt: new Date() })
      .where(eq(messages.id, values.threadRootId));
  }
  return row;
}

/** Editing keeps what was there: the old blocks become a row in the history. */
export async function updateMessageBlocks(
  db: Db,
  message: Message,
  blocks: MessageBlock[],
  editedBy: { type: "user" | "bot" | "system"; id: string },
): Promise<Message> {
  await db.insert(messageEdits).values({
    messageId: message.id,
    blocks: message.blocks,
    editedByType: editedBy.type,
    editedById: editedBy.id,
  });
  const now = new Date();
  const [row] = await db
    .update(messages)
    .set({ blocks, editedAt: now, updatedAt: now })
    .where(eq(messages.id, message.id))
    .returning();
  if (!row) throw new Error("message update returned no row");
  return row;
}

export async function listEdits(db: Db, messageId: string): Promise<MessageEdit[]> {
  return db
    .select()
    .from(messageEdits)
    .where(eq(messageEdits.messageId, messageId))
    .orderBy(desc(messageEdits.createdAt));
}

/** Deleting leaves the row: a thread keeps its shape and a reply count stays honest. */
export async function softDeleteMessage(db: Db, message: Message): Promise<Message> {
  const now = new Date();
  const [row] = await db
    .update(messages)
    .set({ deletedAt: now, blocks: [], updatedAt: now })
    .where(eq(messages.id, message.id))
    .returning();
  if (!row) throw new Error("message delete returned no row");
  if (message.threadRootId) {
    await db
      .update(messages)
      .set({ replyCount: sql`greatest(${messages.replyCount} - 1, 0)`, updatedAt: now })
      .where(eq(messages.id, message.threadRootId));
  }
  return row;
}

export async function pinMessage(
  db: Db,
  values: { channelId: string; messageId: string; pinnedBy: string },
): Promise<void> {
  await db.insert(pins).values(values).onConflictDoNothing();
}

export async function unpinMessage(db: Db, channelId: string, messageId: string): Promise<boolean> {
  const rows = await db
    .delete(pins)
    .where(and(eq(pins.channelId, channelId), eq(pins.messageId, messageId)))
    .returning({ id: pins.id });
  return rows.length > 0;
}

/** The pinned messages of a channel, newest pin first (spec §5.2 channel header). */
export async function listPinned(db: Db, channelId: string, userId: string): Promise<MessageRow[]> {
  const rows = await db
    .select({ message: messages, name: users.name, handle: users.handle })
    .from(pins)
    .innerJoin(messages, eq(pins.messageId, messages.id))
    .leftJoin(users, and(eq(messages.authorType, "user"), eq(messages.authorId, users.id)))
    .where(and(eq(pins.channelId, channelId), isNull(messages.deletedAt)))
    .orderBy(desc(pins.createdAt));
  const ids = rows.map((row) => row.message.id);
  return decorate(
    rows,
    new Set(ids),
    await bookmarkedBy(db, userId, ids),
    await reactionsOn(db, ids, userId),
  );
}

export async function bookmarkMessage(
  db: Db,
  values: { userId: string; messageId: string; note?: string | null },
): Promise<void> {
  await db.insert(bookmarks).values(values).onConflictDoNothing();
}

export async function unbookmarkMessage(
  db: Db,
  userId: string,
  messageId: string,
): Promise<boolean> {
  const rows = await db
    .delete(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.messageId, messageId)))
    .returning({ id: bookmarks.id });
  return rows.length > 0;
}

/** Everything one person saved for later (spec §4 "Later"), newest first. */
export async function listBookmarks(db: Db, userId: string): Promise<MessageRow[]> {
  const rows = await db
    .select({ message: messages, name: users.name, handle: users.handle })
    .from(bookmarks)
    .innerJoin(messages, eq(bookmarks.messageId, messages.id))
    .leftJoin(users, and(eq(messages.authorType, "user"), eq(messages.authorId, users.id)))
    .where(and(eq(bookmarks.userId, userId), isNull(messages.deletedAt)))
    .orderBy(desc(bookmarks.createdAt));
  const ids = rows.map((row) => row.message.id);
  return decorate(rows, await pinnedIn(db, ids), new Set(ids), await reactionsOn(db, ids, userId));
}

/** Where somebody has read up to, and how many of the unread ones named them. */
export async function markRead(
  db: Db,
  values: { userId: string; channelId: string; lastReadMessageId: string; mentionCount?: number },
): Promise<void> {
  await db
    .insert(readState)
    .values({
      userId: values.userId,
      channelId: values.channelId,
      lastReadMessageId: values.lastReadMessageId,
      mentionCount: values.mentionCount ?? 0,
    })
    .onConflictDoUpdate({
      target: [readState.userId, readState.channelId],
      set: {
        lastReadMessageId: values.lastReadMessageId,
        mentionCount: values.mentionCount ?? 0,
        updatedAt: new Date(),
      },
    });
}

/** One more message naming somebody, for everybody the message named. */
export async function addMentions(db: Db, channelId: string, userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    await db
      .insert(readState)
      .values({ userId, channelId, mentionCount: 1 })
      .onConflictDoUpdate({
        target: [readState.userId, readState.channelId],
        set: { mentionCount: sql`${readState.mentionCount} + 1`, updatedAt: new Date() },
      });
  }
}

/** The people a workspace has, for resolving `<@handle>` and for the composer's autocomplete. */
export async function usersByHandle(
  db: Db,
  handles: string[],
): Promise<{ id: string; handle: string; name: string }[]> {
  if (handles.length === 0) return [];
  return db
    .select({ id: users.id, handle: users.handle, name: users.name })
    .from(users)
    .where(inArray(users.handle, handles));
}
