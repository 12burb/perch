import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { citext, id, timestamps, timestamptz } from "../columns.ts";
import type { ApiTokenScopes, InstanceSettingValue, WorkspaceSettings } from "../shapes/index.ts";
import { users } from "./identity.ts";

export const workspaces = pgTable("workspaces", {
  id: id(),
  slug: citext("slug").notNull().unique(),
  name: text("name").notNull(),
  settings: jsonb("settings").$type<WorkspaceSettings>().notNull().default({}),
  /** `.perch/policy.yaml` for the whole workspace, as it was written (spec §5.7; task 2.11). */
  policyYaml: text("policy_yaml"),
  // A deployment descriptor, never a billing tier: Perch has no paid plans (ADR-0064).
  plan: text("plan").notNull().default("self-hosted"),
  ...timestamps(),
});

export const MEMBERSHIP_ROLES = ["owner", "admin", "member"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<MembershipRole>().notNull().default("member"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("memberships_workspace_user_idx").on(t.workspaceId, t.userId),
    index("memberships_user_idx").on(t.userId),
    check("memberships_role_check", sql`${t.role} in ('owner', 'admin', 'member')`),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: citext("email").notNull(),
    role: text("role").$type<MembershipRole>().notNull().default("member"),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamptz("expires_at").notNull(),
    acceptedAt: timestamptz("accepted_at"),
    ...timestamps(),
  },
  (t) => [
    index("invites_workspace_email_idx").on(t.workspaceId, t.email),
    check("invites_role_check", sql`${t.role} in ('owner', 'admin', 'member')`),
  ],
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: jsonb("scopes").$type<ApiTokenScopes>().notNull().default([]),
    lastUsedAt: timestamptz("last_used_at"),
    expiresAt: timestamptz("expires_at"),
    ...timestamps(),
  },
  (t) => [index("api_tokens_user_idx").on(t.userId)],
);

/** Instance-wide settings: PERCH_PUBLIC_URL overrides, telemetry opt-in, feature flags, instance_id. */
export const instanceSettings = pgTable("instance_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<InstanceSettingValue>().notNull(),
  ...timestamps(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type InstanceSetting = typeof instanceSettings.$inferSelect;
