import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { citext, id, timestamps, timestamptz, tsvector } from "../columns.ts";
import type { MessageBlock, ThreadFactValue } from "../shapes/index.ts";
import { users } from "./identity.ts";
import { projects } from "./projects.ts";
import { workspaces } from "./tenancy.ts";

export const CHANNEL_TYPES = ["public", "private", "dm", "group", "item"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const MEMBER_TYPES = ["user", "bot"] as const;
export type MemberType = (typeof MEMBER_TYPES)[number];
export const AUTHOR_TYPES = ["user", "bot", "system"] as const;
export type AuthorType = (typeof AUTHOR_TYPES)[number];

export const channels = pgTable(
  "channels",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").$type<ChannelType>().notNull(),
    name: citext("name"),
    topic: text("topic"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    archivedAt: timestamptz("archived_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("channels_workspace_name_idx")
      .on(t.workspaceId, t.name)
      .where(sql`${t.name} is not null`),
    index("channels_workspace_type_idx").on(t.workspaceId, t.type),
    check("channels_type_check", sql`${t.type} in ('public', 'private', 'dm', 'group', 'item')`),
  ],
);

export const channelMembers = pgTable(
  "channel_members",
  {
    id: id(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    memberType: text("member_type").$type<MemberType>().notNull(),
    memberId: uuid("member_id").notNull(),
    role: text("role").notNull().default("member"),
    joinedAt: timestamptz("joined_at").notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("channel_members_unique_idx").on(t.channelId, t.memberType, t.memberId),
    index("channel_members_member_idx").on(t.memberType, t.memberId),
    check("channel_members_type_check", sql`${t.memberType} in ('user', 'bot')`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    threadRootId: uuid("thread_root_id").references((): AnyPgColumn => messages.id, {
      onDelete: "cascade",
    }),
    authorType: text("author_type").$type<AuthorType>().notNull(),
    authorId: uuid("author_id").notNull(),
    blocks: jsonb("blocks").$type<MessageBlock[]>().notNull().default([]),
    // Full text of every block that carries text, so search needs no separate column (spec §6).
    textSearch: tsvector("text_search").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(jsonb_path_query_array(blocks, '$[*].text')::text, '') || ' ' || coalesce(jsonb_path_query_array(blocks, '$[*].code')::text, ''))`,
    ),
    replyCount: integer("reply_count").notNull().default(0),
    editedAt: timestamptz("edited_at"),
    deletedAt: timestamptz("deleted_at"),
    ...timestamps(),
  },
  (t) => [
    index("messages_channel_created_idx").on(t.channelId, t.createdAt.desc()),
    index("messages_thread_created_idx").on(t.threadRootId, t.createdAt),
    index("messages_text_search_idx").using("gin", t.textSearch),
    // Which messages point at a file (task 2.4): `blocks @> '[{"type":"file","fileId":"…"}]'`
    // is what decides whether somebody may read an attachment, so it has an index of its own.
    index("messages_blocks_idx").using("gin", sql`${t.blocks} jsonb_path_ops`),
    check("messages_author_type_check", sql`${t.authorType} in ('user', 'bot', 'system')`),
  ],
);

/**
 * What a message said before it was edited (spec §5.2 "edit/delete with history"; task 2.2). One
 * row per edit, holding the blocks as they were, so "(edited)" can be opened rather than merely
 * believed. The current text stays on the message itself.
 */
export const messageEdits = pgTable(
  "message_edits",
  {
    id: id(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** The blocks this edit replaced. */
    blocks: jsonb("blocks").$type<MessageBlock[]>().notNull(),
    editedByType: text("edited_by_type").$type<AuthorType>().notNull(),
    editedById: uuid("edited_by_id").notNull(),
    ...timestamps(),
  },
  (t) => [
    index("message_edits_message_idx").on(t.messageId, t.createdAt.desc()),
    check("message_edits_type_check", sql`${t.editedByType} in ('user', 'bot', 'system')`),
  ],
);

export const messageReactions = pgTable(
  "message_reactions",
  {
    id: id(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    memberType: text("member_type").$type<MemberType>().notNull(),
    memberId: uuid("member_id").notNull(),
    emoji: text("emoji").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("message_reactions_unique_idx").on(t.messageId, t.memberType, t.memberId, t.emoji),
    check("message_reactions_type_check", sql`${t.memberType} in ('user', 'bot')`),
  ],
);

export const pins = pgTable(
  "pins",
  {
    id: id(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    pinnedBy: uuid("pinned_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("pins_channel_message_idx").on(t.channelId, t.messageId)],
);

export const bookmarks = pgTable(
  "bookmarks",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    note: text("note"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("bookmarks_user_message_idx").on(t.userId, t.messageId)],
);

export const readState = pgTable(
  "read_state",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    lastReadMessageId: uuid("last_read_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    mentionCount: integer("mention_count").notNull().default(0),
    ...timestamps(),
  },
  (t) => [uniqueIndex("read_state_user_channel_idx").on(t.userId, t.channelId)],
);

export const threadFacts = pgTable(
  "thread_facts",
  {
    id: id(),
    threadRootId: uuid("thread_root_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").$type<ThreadFactValue>().notNull(),
    updatedByType: text("updated_by_type").$type<MemberType>().notNull(),
    updatedById: uuid("updated_by_id").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("thread_facts_thread_key_idx").on(t.threadRootId, t.key),
    check("thread_facts_type_check", sql`${t.updatedByType} in ('user', 'bot')`),
  ],
);

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
export type ChannelMember = typeof channelMembers.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MessageEdit = typeof messageEdits.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type MessageReaction = typeof messageReactions.$inferSelect;
export type Pin = typeof pins.$inferSelect;
export type Bookmark = typeof bookmarks.$inferSelect;
export type ReadState = typeof readState.$inferSelect;
export type ThreadFact = typeof threadFacts.$inferSelect;
