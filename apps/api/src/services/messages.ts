/**
 * Messages (spec §5.2, §6, §7.1; task 2.2). What is said in a channel, what it said before it was
 * edited, what hangs off it in a thread, and what a person saved or pinned.
 *
 * Pure functions over `Db` and `Bus` (spec §9.1). A message is blocks, never a string: the composer
 * sends text and code, and bots send cards, and both go in the same column.
 */
import type { Bus } from "@perch/bus";
import type { Channel, Db, Message, MessageBlock } from "@perch/db";
import { messageBlocksSchema } from "@perch/db";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { findMember } from "../repos/channels.ts";
import {
  addMentions,
  addReaction,
  bookmarkMessage,
  getMessage,
  insertMessage,
  listBookmarks,
  listEdits,
  listMessages,
  type MessageRow,
  markRead,
  pinMessage,
  removeReaction,
  rewriteMessageBlocks,
  softDeleteMessage,
  unbookmarkMessage,
  unpinMessage,
  usersByHandle,
} from "../repos/messages.ts";
import { visibleChannelIds } from "../repos/search.ts";
import { fileIdsIn, filesByIds } from "./files.ts";

export type MessageDeps = { db: { db: Db }; bus: Bus };

/**
 * Mentions on the wire are `<@handle>` for a person and `<#name>` for a channel — the shape §7.3
 * already promises bots (`A bot posting <@dawn> triggers exactly the same mention path as a
 * human`). The composer writes them when somebody picks from its list; the client renders them
 * back as names. Bots and groups get their own prefix when they arrive (tasks 2.6 and 2.7).
 */
const MENTION = /<@([a-z0-9][a-z0-9._-]{0,63})>/gi;

export function mentionedHandles(blocks: MessageBlock[]): string[] {
  const found = new Set<string>();
  for (const block of blocks) {
    const text = "text" in block && typeof block.text === "string" ? block.text : "";
    for (const match of text.matchAll(MENTION)) {
      const handle = match[1];
      if (handle) found.add(handle.toLowerCase());
    }
  }
  return [...found];
}

/** Text typed into the composer, as the one block it is. Empty text is not a message. */
export function textBlocks(text: string): MessageBlock[] {
  const trimmed = text.trim();
  if (!trimmed) throw PerchError.validation("a message needs something in it");
  return [{ type: "text", text: trimmed }];
}

/**
 * The cards Perch posts about its own work: a session, a diff, a race, a deploy, the merge queue,
 * a background run, preflight, an orchestrator's plan, a webhook delivery. Each is a record Perch
 * vouches for — the transcript draws it as trusted and some of them carry an action (a race's
 * Pick) or a link into the app — so each is written only by the service that did the work, which
 * inserts it directly. A person composing a message, or a bot over the Bot API, sends what spec
 * §5.2 calls a message's own blocks: text, code, a file, a tool card, the interactive ones.
 */
export const SYSTEM_CARD_TYPES: ReadonlySet<string> = new Set([
  "diff_card",
  "session_card",
  "webhook_card",
  "deploy_card",
  "race_card",
  "preflight_card",
  "background_card",
  "queue_card",
  "plan_card",
]);

/**
 * Blocks sent by a person (`POST`/`PATCH` a message) or a bot over the Bot API, checked against
 * the schema and against the cards only Perch's own services write (ADR-0174).
 */
export function parseBlocks(blocks: unknown): MessageBlock[] {
  const parsed = messageBlocksSchema.safeParse(blocks);
  if (!parsed.success) throw PerchError.validation("those blocks are not a message");
  if (parsed.data.length === 0) throw PerchError.validation("a message needs something in it");
  const card = parsed.data.find((block) => SYSTEM_CARD_TYPES.has(block.type));
  if (card) {
    throw PerchError.validation(`a ${card.type} is posted by Perch itself, not sent as a message`, {
      type: card.type,
    });
  }
  return parsed.data;
}

/** Everybody writes in a channel they are in, and nobody writes in one that is archived. */
export async function requireWriteable(
  deps: MessageDeps,
  channel: Channel,
  userId: string,
): Promise<void> {
  if (channel.archivedAt) throw PerchError.conflict("this channel is archived");
  const inside = await findMember(deps.db.db, channel.id, "user", userId);
  if (!inside) throw PerchError.conflict("join this channel before writing in it");
}

/**
 * A `file` block may only point at a file of this workspace (task 2.3). Ids are guessable in the
 * sense that any uuid is; the check is what stops one workspace naming another's upload.
 */
export async function requireOwnFiles(
  deps: MessageDeps,
  workspaceId: string,
  blocks: MessageBlock[],
): Promise<void> {
  const ids = fileIdsIn([{ blocks }]);
  if (ids.length === 0) return;
  const found = await filesByIds(deps.db.db, ids);
  for (const id of ids) {
    const file = found.get(id);
    if (!file || file.workspaceId !== workspaceId) {
      throw PerchError.validation("that file is not in this workspace");
    }
  }
}

export async function messages(
  deps: MessageDeps,
  channel: Channel,
  userId: string,
  options: { before?: string | undefined; after?: string | undefined; limit?: number | undefined },
): Promise<MessageRow[]> {
  return listMessages(deps.db.db, channel.id, userId, options);
}

export async function thread(
  deps: MessageDeps,
  channel: Channel,
  rootId: string,
  userId: string,
): Promise<MessageRow[]> {
  return listMessages(deps.db.db, channel.id, userId, { threadRootId: rootId, limit: 200 });
}

export type PostInput = {
  channel: Channel;
  userId: string;
  blocks: MessageBlock[];
  threadRootId?: string | undefined;
  by: ActorContext;
};

/** A message, and the mention counts it bumps for everybody it named. */
export async function post(deps: MessageDeps, input: PostInput): Promise<Message> {
  await requireWriteable(deps, input.channel, input.userId);
  await requireOwnFiles(deps, input.channel.workspaceId, input.blocks);
  let threadRootId: string | null = null;
  if (input.threadRootId) {
    const root = await getMessage(deps.db.db, input.threadRootId);
    if (!root || root.channelId !== input.channel.id) throw PerchError.notFound("message");
    // A thread is one deep: replying to a reply joins the same thread (spec §5.2).
    threadRootId = root.threadRootId ?? root.id;
  }
  const message = await insertMessage(deps.db.db, {
    workspaceId: input.channel.workspaceId,
    channelId: input.channel.id,
    threadRootId,
    authorType: "user",
    authorId: input.userId,
    blocks: input.blocks,
  });
  await notifyMentions(deps, input.channel, input.blocks, input.userId);
  await deps.bus.publish(
    "message.created",
    {
      workspaceId: input.channel.workspaceId,
      channelId: input.channel.id,
      messageId: message.id,
      ...(threadRootId ? { threadRootId } : {}),
      authorType: "user" as const,
      authorId: input.userId,
    },
    input.by,
  );
  return message;
}

/**
 * Everybody named who is in the channel, except the person doing the naming. `alreadyNamed` is the
 * handles an earlier version of the same message named: an edit that keeps a mention is not a
 * second mention, so only the ones it adds count.
 */
async function notifyMentions(
  deps: MessageDeps,
  channel: Channel,
  blocks: MessageBlock[],
  authorId: string,
  alreadyNamed: readonly string[] = [],
): Promise<void> {
  const handles = mentionedHandles(blocks).filter((handle) => !alreadyNamed.includes(handle));
  if (handles.length === 0) return;
  const people = await usersByHandle(deps.db.db, handles);
  const named: string[] = [];
  for (const person of people) {
    if (person.id === authorId) continue;
    if (await findMember(deps.db.db, channel.id, "user", person.id)) named.push(person.id);
  }
  if (named.length > 0) await addMentions(deps.db.db, channel.id, named);
}

/**
 * Editing is the author's own; the history keeps what was there (spec §5.2). An archived channel is
 * a record, so nothing in it is rewritten.
 */
export async function edit(
  deps: MessageDeps,
  input: {
    channel: Channel;
    message: Message;
    userId: string;
    blocks: MessageBlock[];
    by: ActorContext;
  },
): Promise<Message> {
  if (input.message.deletedAt) throw PerchError.conflict("that message is gone");
  if (input.message.authorType !== "user" || input.message.authorId !== input.userId) {
    throw PerchError.forbidden("only the person who wrote a message edits it");
  }
  if (input.channel.archivedAt) throw PerchError.conflict("this channel is archived");
  await requireOwnFiles(deps, input.channel.workspaceId, input.blocks);
  // The version this edit replaces is the one in the row when it lands, not the one this request
  // read: that is what the history keeps, and what decides which mentions are new.
  let replaced: MessageBlock[] = [];
  const row = await rewriteMessageBlocks(
    deps.db.db,
    input.message.id,
    (current) => {
      replaced = current.blocks;
      return input.blocks;
    },
    { type: "user", id: input.userId },
  );
  if (!row) throw PerchError.conflict("that message is gone");
  await notifyMentions(deps, input.channel, input.blocks, input.userId, mentionedHandles(replaced));
  await deps.bus.publish(
    "message.updated",
    {
      workspaceId: input.channel.workspaceId,
      channelId: input.channel.id,
      messageId: row.id,
    },
    input.by,
  );
  return row;
}

/** What a message said before. A deleted message said nothing, then or now. */
export async function history(deps: MessageDeps, message: Message) {
  if (message.deletedAt) return [];
  return listEdits(deps.db.db, message.id);
}

/**
 * Deleting is the author's, or an admin's when something has to go (spec §5.2). In an archived
 * channel only the admin may: the record stays as it was unless it has to change.
 */
export async function remove(
  deps: MessageDeps,
  input: {
    channel: Channel;
    message: Message;
    userId: string;
    canModerate: boolean;
    by: ActorContext;
  },
): Promise<void> {
  const mine = input.message.authorType === "user" && input.message.authorId === input.userId;
  if (!mine && !input.canModerate) {
    throw PerchError.forbidden("only the person who wrote a message deletes it");
  }
  if (input.message.deletedAt) return;
  if (input.channel.archivedAt && !input.canModerate) {
    throw PerchError.conflict("this channel is archived");
  }
  // Two deletes of one message are one: whichever lands second finds nothing to take down, and
  // nobody is told twice.
  if (!(await softDeleteMessage(deps.db.db, input.message))) return;
  await deps.bus.publish(
    "message.deleted",
    {
      workspaceId: input.channel.workspaceId,
      channelId: input.channel.id,
      messageId: input.message.id,
    },
    input.by,
  );
}

export async function pin(
  deps: MessageDeps,
  input: { channel: Channel; message: Message; userId: string; pinned: boolean; by: ActorContext },
): Promise<void> {
  await requireWriteable(deps, input.channel, input.userId);
  if (input.pinned) {
    await pinMessage(deps.db.db, {
      channelId: input.channel.id,
      messageId: input.message.id,
      pinnedBy: input.userId,
    });
  } else {
    await unpinMessage(deps.db.db, input.channel.id, input.message.id);
  }
  // A pin is something about the message, so it travels as the message changing.
  await deps.bus.publish(
    "message.updated",
    {
      workspaceId: input.channel.workspaceId,
      channelId: input.channel.id,
      messageId: input.message.id,
    },
    input.by,
  );
}

/**
 * An emoji, as a reaction is allowed to be (task 2.3): a handful of code points and nothing that
 * would make a pill something other than an emoji — no whitespace, no controls, no essay.
 */
export function parseEmoji(raw: string): string {
  const emoji = raw.trim();
  const points = [...emoji];
  if (points.length === 0 || points.length > 8 || emoji.length > 64) {
    throw PerchError.validation("that is not an emoji");
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  if (/[\s\u0000-\u001f\u007f]/.test(emoji)) throw PerchError.validation("that is not an emoji");
  return emoji;
}

/**
 * Putting an emoji on a message, or taking yours off (spec §5.2; task 2.3). A reaction is the
 * channel's, so it needs the channel: everybody in the room sees it, and only people in the room
 * may add one.
 */
export async function react(
  deps: MessageDeps,
  input: {
    channel: Channel;
    message: Message;
    userId: string;
    emoji: string;
    on: boolean;
    by: ActorContext;
  },
): Promise<void> {
  await requireWriteable(deps, input.channel, input.userId);
  if (input.message.deletedAt) throw PerchError.conflict("that message is gone");
  const values = {
    messageId: input.message.id,
    memberType: "user" as const,
    memberId: input.userId,
    emoji: parseEmoji(input.emoji),
  };
  const changed = input.on
    ? await addReaction(deps.db.db, values)
    : await removeReaction(deps.db.db, values);
  // Reacting twice is the reaction you already had: nothing changed, so nobody is told.
  if (!changed) return;
  await deps.bus.publish(
    input.on ? "reaction.added" : "reaction.removed",
    {
      workspaceId: input.channel.workspaceId,
      channelId: input.channel.id,
      messageId: input.message.id,
      emoji: values.emoji,
      memberType: "user" as const,
      memberId: input.userId,
    },
    input.by,
  );
}

/** A bookmark is one person's own Later list: nobody else sees it, so nothing is published. */
export async function bookmark(
  deps: MessageDeps,
  input: { message: Message; userId: string; saved: boolean; note?: string | undefined },
): Promise<void> {
  if (input.saved) {
    await bookmarkMessage(deps.db.db, {
      userId: input.userId,
      messageId: input.message.id,
      note: input.note ?? null,
    });
  } else {
    await unbookmarkMessage(deps.db.db, input.userId, input.message.id);
  }
}

/**
 * One person's Later list in one workspace (spec §4). A bookmark is kept when its channel is left,
 * so what it points at is checked against the channels this person can open now — the same scope
 * search uses — every time the list is read.
 */
export async function bookmarks(
  deps: MessageDeps,
  input: {
    workspaceId: string;
    userId: string;
    before?: string | undefined;
    limit?: number | undefined;
  },
): Promise<MessageRow[]> {
  return listBookmarks(deps.db.db, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    scope: await visibleChannelIds(deps.db.db, input.workspaceId, input.userId),
    before: input.before,
    limit: input.limit,
  });
}

/** Where somebody has read up to. Reading clears what named them there. */
export async function read(
  deps: MessageDeps,
  input: { channel: Channel; userId: string; messageId: string; by: ActorContext },
): Promise<void> {
  const message = await getMessage(deps.db.db, input.messageId);
  if (!message || message.channelId !== input.channel.id) throw PerchError.notFound("message");
  await markRead(deps.db.db, {
    userId: input.userId,
    channelId: input.channel.id,
    lastReadMessageId: input.messageId,
  });
  await deps.bus.publish(
    "read_state.updated",
    {
      workspaceId: input.channel.workspaceId,
      userId: input.userId,
      channelId: input.channel.id,
      lastReadMessageId: input.messageId,
    },
    input.by,
  );
}
