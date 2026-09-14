import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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

export const PROJECT_SOURCES = ["empty", "upload", "clone"] as const;
export type ProjectSource = (typeof PROJECT_SOURCES)[number];
/** pending → setting_up (on a runner) → ready | error (task 1.4, ADR-0069). */
export const PROJECT_STATUSES = ["pending", "setting_up", "ready", "error"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

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
    /** How the directory came to be: created empty, uploaded, or cloned (task 1.4). */
    source: text("source").$type<ProjectSource>().notNull().default("empty"),
    status: text("status").$type<ProjectStatus>().notNull().default("pending"),
    /** Why setup failed, or what postCreateCommand reported; never a credential. */
    statusMessage: text("status_message"),
    /** The runner holding the project directory. */
    runnerId: uuid("runner_id").references((): AnyPgColumn => runners.id, {
      onDelete: "set null",
    }),
    head: text("head"),
    /** Why the checked-in .perch/project.json was not applied (config stays {} then). */
    configError: text("config_error"),
    /** The parsed devcontainer.json (JSONC), when the project ships one. */
    devcontainer: jsonb("devcontainer").$type<Record<string, unknown>>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("projects_workspace_key_idx").on(t.workspaceId, t.key),
    check("projects_source_check", sql`${t.source} in ('empty', 'upload', 'clone')`),
    check("projects_status_check", sql`${t.status} in ('pending', 'setting_up', 'ready', 'error')`),
  ],
);

/**
 * One SSH deploy key per workspace (spec §5.1): the public half is added to repositories, the private
 * half is vault-encrypted and only ever decrypted for a clone on a runner.
 */
export const deployKeys = pgTable("deploy_keys", {
  id: id(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** OpenSSH public key line: `ssh-ed25519 AAAA… perch-<workspace>`. */
  publicKey: text("public_key").notNull(),
  /** `SHA256:…` of the public key blob, as ssh-keygen -l prints it. */
  fingerprint: text("fingerprint").notNull(),
  privateKeyCiphertext: bytea("private_key_ciphertext").notNull(),
  ...timestamps(),
});

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
export type DeployKey = typeof deployKeys.$inferSelect;
export type Runner = typeof runners.$inferSelect;
export type RunnerToken = typeof runnerTokens.$inferSelect;
export type ProjectEnvRow = typeof projectEnv.$inferSelect;
export type Policy = typeof policies.$inferSelect;
export type PreviewShare = typeof previewShares.$inferSelect;
