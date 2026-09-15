/**
 * The approval inbox (spec §6 `inbox_items`, §5.7 "one queue for permission prompts, preflight
 * results, PRs awaiting review, budget alerts, failed bot runs, chain breakers, intake, mentions";
 * task 2.10).
 *
 * An item is one thing waiting for one person. It points at whatever it is about — a permission, a
 * message, a thread, a bot — and carries the line the inbox and the phone both show, so a queue of
 * twenty renders in one query (ADR-0100).
 */
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps, timestamptz } from "../columns.ts";
import type { InboxPayload } from "../shapes/index.ts";
import { users } from "./identity.ts";
import { workspaces } from "./tenancy.ts";

/** What put it there (spec §6). */
export const INBOX_KINDS = [
  "permission",
  "preflight",
  "pr",
  "budget",
  "bot_failure",
  "chain",
  "intake",
  "mention",
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** Open until somebody deals with it; snoozed until a moment; resolved once it is done. */
export const INBOX_STATUSES = ["open", "snoozed", "resolved"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export const inboxItems = pgTable(
  "inbox_items",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<InboxKind>().notNull(),
    /** What it is about, and which one: "session_permission", "message", "thread", "bot". */
    refType: text("ref_type").notNull(),
    /** Not a uuid: an engine's permission id is its own string (spec §7.6). */
    refId: text("ref_id").notNull(),
    status: text("status").$type<InboxStatus>().notNull().default("open"),
    /** What it says, written when it arrives so the queue reads in one go (ADR-0100). */
    payload: jsonb("payload").$type<InboxPayload>().notNull().default({}),
    snoozedUntil: timestamptz("snoozed_until"),
    resolvedAt: timestamptz("resolved_at"),
    ...timestamps(),
  },
  (t) => [
    index("inbox_items_user_status_idx").on(t.userId, t.status, t.createdAt.desc()),
    // One thing, one item: an event seen twice does not ask somebody the same question twice.
    uniqueIndex("inbox_items_ref_idx").on(t.userId, t.kind, t.refType, t.refId),
    check(
      "inbox_items_kind_check",
      sql`${t.kind} in ('permission', 'preflight', 'pr', 'budget', 'bot_failure', 'chain', 'intake', 'mention')`,
    ),
    check("inbox_items_status_check", sql`${t.status} in ('open', 'snoozed', 'resolved')`),
  ],
);

export type InboxItem = typeof inboxItems.$inferSelect;
export type NewInboxItem = typeof inboxItems.$inferInsert;
