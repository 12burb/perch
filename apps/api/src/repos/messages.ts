/**
 * messages, message_edits, message_reactions, pins, bookmarks and read_state (spec §6; tasks 2.2
 * and 2.3). Paging is by id: ids are UUIDv7 (ADR-0025), so `before` and `after` are id comparisons
 * and a page cannot slip when two messages land in the same instant.
 */
import type { Db, Message, MessageBlock, MessageEdit } from "@perch/db";
import { schema } from "@perch/db";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

const { messages, messageEdits, messageReactions, pins, bookmarks, readState, users, bots } =
  schema;

/** One emoji on one message: how many put it there, and whether the caller is one of them. */
export type ReactionSummary = { emoji: string; count: number; mine: boolean };

export type MessageRow = Message & {
  /** Who said it: a person's name and handle, or a bot's (task 2.6). Null for the system. */
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
  rows: {
    message: Message;
    name: string | null;
    handle: string | null;
    botName: string | null;
    botHandle: string | null;
  }[],
  pinnedIds: Set<string>,
  bookmarkedIds: Set<string>,
  reactions: Map<string, ReactionSummary[]>,
): MessageRow[] {
  return rows.map((row) => ({
    ...row.message,
    authorName: row.name ?? row.botName,
    authorHandle: row.handle ?? row.botHandle,
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
    .select({
      message: messages,
      name: users.name,
      handle: users.handle,
      botName: bots.name,
      botHandle: bots.handle,
    })
    .from(messages)
    .leftJoin(users, and(eq(messages.authorType, "user"), eq(messages.authorId, users.id)))
    .leftJoin(bots, and(eq(messages.authorType, "bot"), eq(messages.authorId, bots.id)))
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
    .select({
      message: messages,
      name: users.name,
      handle: users.handle,
      botName: bots.name,
      botHandle: bots.handle,
    })
    .from(messages)
    .leftJoin(users, and(eq(messages.authorType, "user"), eq(messages.authorId, users.id)))
    .leftJoin(bots, and(eq(messages.authorType, "bot"), eq(messages.authorId, bots.id)))
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

/** Who changed a message's blocks, and whether the change is an edit that keeps history. */
export type EditedBy = { type: "user" | "bot" | "system"; id: string; history?: boolean };

/**
 * Editing keeps what was there: the old blocks become a row in the history.
 *
 * `history: false` is for a change that is not an edit — an interactive block recording the answer
 * it was given (task 2.5), a streaming reply, a card moving. Nobody rewrote the message, so it
 * keeps no history and gains no "(edited)" mark; what changed is visible in the block itself.
 *
 * A deleted message is never written to: the answer is null, and the caller stops there (a bot's
 * stream, a card's next state) rather than putting the words back into a row somebody took down.
 */
export async function updateMessageBlocks(
  db: Db,
  message: Message,
  blocks: MessageBlock[],
  editedBy: EditedBy,
): Promise<Message | null> {
  if (editedBy.history !== false) {
    return rewriteMessageBlocks(db, message.id, () => blocks, editedBy);
  }
  const now = new Date();
  const [row] = await db
    .update(messages)
    .set({ blocks, updatedAt: now })
    .where(and(eq(messages.id, message.id), isNull(messages.deletedAt)))
    .returning();
  return row ?? null;
}

/**
 * Blocks rewritten from the row as it is now, not as some caller read it earlier. The row is
 * locked for the length of the change, so two edits each record the version before their own, and
 * two answers to one card see each other: `change` is handed the current row and may throw to
 * refuse (a block somebody already answered), which rolls the whole change back.
 *
 * `change` runs inside the transaction and must not query anything itself.
 */
export async function rewriteMessageBlocks(
  db: Db,
  messageId: string,
  change: (current: Message) => MessageBlock[],
  editedBy: EditedBy,
): Promise<Message | null> {
  const keepHistory = editedBy.history !== false;
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
      .for("update");
    if (!current) return null;
    const blocks = change(current);
    if (keepHistory) {
      await tx.insert(messageEdits).values({
        messageId,
        blocks: current.blocks,
        editedByType: editedBy.type,
        editedById: editedBy.id,
      });
    }
    const now = new Date();
    const [row] = await tx
      .update(messages)
      .set({ blocks, ...(keepHistory ? { editedAt: now } : {}), updatedAt: now })
      .where(eq(messages.id, messageId))
      .returning();
    return row ?? null;
  });
}

export async function listEdits(db: Db, messageId: string): Promise<MessageEdit[]> {
  return db
    .select()
    .from(messageEdits)
    .where(eq(messageEdits.messageId, messageId))
    .orderBy(desc(messageEdits.createdAt));
}

/**
 * Deleting leaves the row: a thread keeps its shape and a reply count stays honest. What the
 * message said goes with it — its blocks and every earlier version in its history — so a delete is
 * one, however many people pressed it at once.
 *
 * Null when it was already gone: the second of two deletes changes nothing, and takes nothing off
 * the thread's count.
 */
export async function softDeleteMessage(db: Db, message: Message): Promise<Message | null> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(messages)
      .set({ deletedAt: now, blocks: [], updatedAt: now })
      .where(and(eq(messages.id, message.id), isNull(messages.deletedAt)))
      .returning();
    if (!row) return null;
    await tx.delete(messageEdits).where(eq(messageEdits.messageId, row.id));
    if (row.threadRootId) {
      await tx
        .update(messages)
        .set({ replyCount: sql`greatest(${messages.replyCount} - 1, 0)`, updatedAt: now })
        .where(eq(messages.id, row.threadRootId));
    }
    return row;
  });
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
    .select({
      message: messages,
      name: users.name,
      handle: users.handle,
      botName: bots.name,
      botHandle: bots.handle,
    })
    .from(pins)
    .innerJoin(messages, eq(pins.messageId, messages.id))
    .leftJoin(users, and(eq(messages.authorType, "user"), eq(messages.authorId, users.id)))
    .leftJoin(bots, and(eq(messages.authorType, "bot"), eq(messages.authorId, bots.id)))
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

export type BookmarkQuery = {
  userId: string;
  workspaceId: string;
  /**
   * The channels the caller may open right now. A bookmark outlives a membership, so what it
   * points at is checked against this every time rather than when it was saved.
   */
  scope: string[];
  /** The page after this message's bookmark: older saves. */
  before?: string | undefined;
  limit?: number | undefined;
};

/**
 * One person's saved-for-later list (spec §4 "Later") in one workspace, newest save first. Only
 * messages in `scope` come back: a message in a channel the caller has since left, or in another
 * workspace, is not theirs to read through a bookmark.
 */
export async function listBookmarks(db: Db, query: BookmarkQuery): Promise<MessageRow[]> {
  if (query.scope.length === 0) return [];
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const where = [
    eq(bookmarks.userId, query.userId),
    eq(messages.workspaceId, query.workspaceId),
    inArray(messages.channelId, query.scope),
    isNull(messages.deletedAt),
  ];
  if (query.before) {
    // Bookmark ids are UUIDv7 (ADR-0025), so "saved before that one" is an id comparison.
    const [cursor] = await db
      .select({ id: bookmarks.id })
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, query.userId), eq(bookmarks.messageId, query.before)))
      .limit(1);
    if (!cursor) return [];
    where.push(lt(bookmarks.id, cursor.id));
  }
  const rows = await db
    .select({
      message: messages,
      name: users.name,
      handle: users.handle,
      botName: bots.name,
      botHandle: bots.handle,
    })
    .from(bookmarks)
    .innerJoin(messages, eq(bookmarks.messageId, messages.id))
    .leftJoin(users, and(eq(messages.authorType, "user"), eq(messages.authorId, users.id)))
    .leftJoin(bots, and(eq(messages.authorType, "bot"), eq(messages.authorId, bots.id)))
    .where(and(...where))
    .orderBy(desc(bookmarks.id))
    .limit(limit);
  const ids = rows.map((row) => row.message.id);
  return decorate(
    rows,
    await pinnedIn(db, ids),
    new Set(ids),
    await reactionsOn(db, ids, query.userId),
  );
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
