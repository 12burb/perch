import { type AnyPgColumn, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { citext, id, timestamps, timestamptz } from "../columns.ts";
import type { NotificationPayload } from "../shapes/index.ts";
import { authUser } from "./auth.ts";
import { files } from "./files.ts";

/** Perch's profile row, keyed 1:1 to better-auth's auth_user (spec §6). */
export const users = pgTable("users", {
  id: id(),
  authUserId: text("auth_user_id")
    .notNull()
    .unique()
    .references(() => authUser.id, { onDelete: "cascade" }),
  email: citext("email").notNull().unique(),
  name: text("name").notNull(),
  handle: citext("handle").notNull().unique(),
  avatarFileId: uuid("avatar_file_id").references((): AnyPgColumn => files.id, {
    onDelete: "set null",
  }),
  locale: text("locale").notNull().default("en"),
  tz: text("tz").notNull().default("UTC"),
  ...timestamps(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<NotificationPayload>().notNull().default({}),
    readAt: timestamptz("read_at"),
    ...timestamps(),
  },
  (t) => [index("notifications_user_created_idx").on(t.userId, t.createdAt.desc())],
);

export type Notification = typeof notifications.$inferSelect;

/**
 * Where to reach somebody who is not looking at Perch (task 2.3, ADR-0093). A subscription is one
 * browser on one device: its endpoint at a push service, and the two keys that service never sees
 * the inside of — the payload is encrypted to them (RFC 8291).
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** What the browser called itself, so a person can tell their devices apart. */
    userAgent: text("user_agent"),
    /** When the push service last took a message; null until one is sent. */
    lastSentAt: timestamptz("last_sent_at"),
    /** When the push service last refused it for good, which is when it stops being used. */
    expiredAt: timestamptz("expired_at"),
    ...timestamps(),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId, t.createdAt.desc())],
);

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;
