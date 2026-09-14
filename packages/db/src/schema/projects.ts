import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, citext, id, timestamps, timestamptz } from "../columns.ts";
import type {
  PolicyRules,
  ProjectConfig,
  RunnerCapabilities,
  RunnerPolicy,
} from "../shapes/index.ts";
import { users } from "./identity.ts";
import { workspaces } from "./tenancy.ts";

export const projects = pgTable(
  "projects",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: citext("key").notNull(),
    name: text("name").notNull(),
    repoUrl: text("repo_url"),
    defaultBranch: text("default_branch").notNull().default("main"),
    defaultEngine: text("default_engine").notNull().default("opencode"),
    // References model_profiles once the brains group lands (task 1.15); until then a bare uuid.
    defaultModelProfileId: uuid("default_model_profile_id"),
    runnerPolicy: jsonb("runner_policy").$type<RunnerPolicy>().notNull().default({}),
    config: jsonb("config").$type<ProjectConfig>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [uniqueIndex("projects_workspace_key_idx").on(t.workspaceId, t.key)],
);

export const RUNNER_KINDS = ["hosted", "local", "remote"] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

export const runners = pgTable(
  "runners",
  {
    id: id(),
    /** Null for a runner every workspace may use: the shared hosted runner (PERCH_RUNNER_MODE=shared). */
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").$type<RunnerKind>().notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("offline"),
    capabilities: jsonb("capabilities").$type<RunnerCapabilities>().notNull().default({}),
    lastSeenAt: timestamptz("last_seen_at"),
    /** Set when the last heartbeat carried no sessions; the supervisor stops idle containers (task 1.2). */
    idleSince: timestamptz("idle_since"),
    containerId: text("container_id"),
    ...timestamps(),
  },
  (t) => [
    index("runners_workspace_kind_idx").on(t.workspaceId, t.kind),
    check("runners_kind_check", sql`${t.kind} in ('hosted', 'local', 'remote')`),
  ],
);

export const runnerTokens = pgTable(
  "runner_tokens",
  {
    id: id(),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamptz("expires_at").notNull(),
    revokedAt: timestamptz("revoked_at"),
    ...timestamps(),
  },
  (t) => [index("runner_tokens_runner_idx").on(t.runnerId)],
);

export const PROJECT_ENV_SOURCES = ["manual", "vercel", "supabase", "vault"] as const;
export type ProjectEnvSource = (typeof PROJECT_ENV_SOURCES)[number];

export const projectEnv = pgTable(
  "project_env",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    source: text("source").$type<ProjectEnvSource>().notNull().default("manual"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("project_env_project_key_idx").on(t.projectId, t.key),
    check(
      "project_env_source_check",
      sql`${t.source} in ('manual', 'vercel', 'supabase', 'vault')`,
    ),
  ],
);

export const policies = pgTable(
  "policies",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    rules: jsonb("rules").$type<PolicyRules>().notNull().default({}),
    version: integer("version").notNull().default(1),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (t) => [index("policies_workspace_project_idx").on(t.workspaceId, t.projectId)],
);

export const previewShares = pgTable(
  "preview_shares",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    port: integer("port").notNull(),
    path: text("path").notNull().default("/"),
    tokenHash: text("token_hash").notNull().unique(),
    public: boolean("public").notNull().default(false),
    expiresAt: timestamptz("expires_at").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    revokedAt: timestamptz("revoked_at"),
    ...timestamps(),
  },
  (t) => [index("preview_shares_workspace_project_idx").on(t.workspaceId, t.projectId)],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Runner = typeof runners.$inferSelect;
export type RunnerToken = typeof runnerTokens.$inferSelect;
export type ProjectEnvRow = typeof projectEnv.$inferSelect;
export type Policy = typeof policies.$inferSelect;
export type PreviewShare = typeof previewShares.$inferSelect;
