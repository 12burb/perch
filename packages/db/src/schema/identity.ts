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
