/**
 * Brains (spec §3.4, §6 provider_credentials and model_profiles; task 1.15): where a model comes
 * from and what it costs. A credential is an API key or an OpenAI-compatible endpoint, encrypted
 * with the vault and never read back out to a client. A model profile names a provider, a model,
 * and the credential to use, so a session or a bot can say "run on this brain" without holding a
 * key. The catalog of models itself is not a table: each provider is asked for its own list when
 * a credential is tested or a model is picked (ADR-0081).
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, id, timestamps, timestamptz } from "../columns.ts";
import { users } from "./identity.ts";
import { workspaces } from "./tenancy.ts";

/** user: one person's own key; workspace: shared with everyone who may use it (spec §3.6). */
export const CREDENTIAL_SCOPES = ["user", "workspace"] as const;
export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number];

/** api_key: a provider key; endpoint: an OpenAI-compatible base URL; oauth_ref: a connection (task 1.16). */
export const CREDENTIAL_KINDS = ["api_key", "endpoint", "oauth_ref"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export const CREDENTIAL_STATUSES = ["active", "invalid", "revoked"] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scope: text("scope").$type<CredentialScope>().notNull().default("user"),
    /** Whose it is. Always set: a workspace credential is owned by the admin who added it. */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** openai, anthropic, ollama, openrouter, … — the id the catalog and the engines use. */
    provider: text("provider").notNull(),
    kind: text("kind").$type<CredentialKind>().notNull().default("api_key"),
    /** The secret, vault-encrypted. An endpoint with no key stores an empty ciphertext. */
    ciphertext: bytea("ciphertext").notNull(),
    /** What the person calls it; shown instead of the secret. */
    label: text("label").notNull(),
    /**
     * The first two and last four characters of the key, so a person can tell two apart later
     * without Perch decrypting anything. Never enough to use, and null for a keyless endpoint.
     */
    hint: text("hint"),
    /** For endpoint providers (Ollama, LM Studio, vLLM, an aggregator). */
    baseUrl: text("base_url"),
    status: text("status").$type<CredentialStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    index("provider_credentials_workspace_idx").on(t.workspaceId, t.provider),
    index("provider_credentials_owner_idx").on(t.ownerId),
    check("provider_credentials_scope_check", sql`${t.scope} in ('user', 'workspace')`),
    check(
      "provider_credentials_kind_check",
      sql`${t.kind} in ('api_key', 'endpoint', 'oauth_ref')`,
    ),
    check(
      "provider_credentials_status_check",
      sql`${t.status} in ('active', 'invalid', 'revoked')`,
    ),
  ],
);
export type ProviderCredential = typeof providerCredentials.$inferSelect;
export type NewProviderCredential = typeof providerCredentials.$inferInsert;

/**
 * What a profile is the default for, when it is one (spec §3.4). `embedding` is the workspace's
 * model for the codebase index (task 2.17, ADR-0110): one brain, named once, and every embedding
 * Perch computes goes through it.
 */
export const PROFILE_DEFAULTS = ["chat", "code", "embedding"] as const;
export type ProfileDefault = (typeof PROFILE_DEFAULTS)[number];

export type ModelParams = {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoningEffort?: string;
};
export type ToolPolicy = { allow?: string[]; deny?: string[] };
export type CostCap = { dailyUsd?: number; perRunUsd?: number };

export const modelProfiles = pgTable(
  "model_profiles",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    /** Null means "whatever the engine is configured with" (an engine on its own login). */
    credentialId: uuid("credential_id").references(() => providerCredentials.id, {
      onDelete: "set null",
    }),
    params: jsonb("params").$type<ModelParams>().notNull().default({}),
    toolPolicy: jsonb("tool_policy").$type<ToolPolicy>().notNull().default({}),
    costCap: jsonb("cost_cap").$type<CostCap>().notNull().default({}),
    /**
     * The profiles to try when this one's provider will not answer, by name and in order
     * (spec §3.4 "fallback chains"; task 4.1, ADR-0147). §6 does not have this column: a chain has
     * to live somewhere, and the profile is the thing a caller names.
     */
    fallbacks: jsonb("fallbacks").$type<string[]>().notNull().default([]),
    defaultFor: text("default_for").$type<ProfileDefault>(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("model_profiles_workspace_name_idx").on(t.workspaceId, t.name),
    // One default per kind per workspace; a second one takes the title by clearing the first.
    uniqueIndex("model_profiles_default_idx")
      .on(t.workspaceId, t.defaultFor)
      .where(sql`${t.defaultFor} is not null`),
    check(
      "model_profiles_default_for_check",
      sql`${t.defaultFor} in ('chat', 'code', 'embedding')`,
    ),
  ],
);
export type ModelProfile = typeof modelProfiles.$inferSelect;
export type NewModelProfile = typeof modelProfiles.$inferInsert;

/**
 * A virtual key (spec §6 `virtual_keys`, §3.4, §7.4; task 4.1): what an external caller reaches
 * `/v1` with. `pk_…` is shown once and stored as a hash — the same shape an api token has, for the
 * same reason.
 */
export const KEY_SUBJECTS = ["user", "bot", "runner", "external"] as const;
export type KeySubject = (typeof KEY_SUBJECTS)[number];

/** What a key may spend, and over what stretch (spec §7.4's `Perch-Budget-Remaining`). */
export type KeyBudget = {
  /** Dollars. Absent means no ceiling. */
  limitUsd?: number;
  /** The window the limit is counted over; `total` is the key's whole life. */
  period?: "day" | "month" | "total";
};

export const virtualKeys = pgTable(
  "virtual_keys",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").$type<KeySubject>().notNull(),
    /** Who it speaks as. Null for `external`, which is a key that is nobody in particular. */
    subjectId: uuid("subject_id"),
    name: text("name").notNull().default(""),
    keyHash: text("key_hash").notNull(),
    /** The first characters of the key, so a list can show which one this is. */
    prefix: text("prefix").notNull(),
    budget: jsonb("budget").$type<KeyBudget>().notNull().default({}),
    /**
     * The model profiles this key may ask for, by name. Empty means the workspace's whole
     * allow-list — §6 does not have this column and ADR-0147 says why it is here.
     */
    models: jsonb("models").$type<string[]>().notNull().default([]),
    expiresAt: timestamptz("expires_at"),
    revokedAt: timestamptz("revoked_at"),
    lastUsedAt: timestamptz("last_used_at"),
    createdBy: uuid("created_by"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("virtual_keys_hash_idx").on(t.keyHash),
    index("virtual_keys_workspace_idx").on(t.workspaceId, t.createdAt),
    check(
      "virtual_keys_subject_check",
      sql`${t.subjectType} in ('user', 'bot', 'runner', 'external')`,
    ),
  ],
);
export type VirtualKey = typeof virtualKeys.$inferSelect;

/**
 * One call's cost (spec §6 `usage_events`, §3.4 "cost logged to usage_events"; task 4.1). The
 * ledger a budget is checked against and the dashboard is drawn from — one row per call, whoever
 * made it: a person in the web app, a bot, a session, or a key on `/v1`.
 */
export const USAGE_ACTORS = ["user", "bot", "runner", "external", "system"] as const;
export type UsageActor = (typeof USAGE_ACTORS)[number];

export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorType: text("actor_type").$type<UsageActor>().notNull(),
    actorId: uuid("actor_id"),
    sessionId: uuid("session_id"),
    botRunId: uuid("bot_run_id"),
    /** The key it came through, when it came through one. */
    virtualKeyId: uuid("virtual_key_id").references(() => virtualKeys.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    ts: timestamptz("ts").notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index("usage_events_workspace_idx").on(t.workspaceId, t.ts),
    index("usage_events_key_idx").on(t.virtualKeyId, t.ts),
    check(
      "usage_events_actor_check",
      sql`${t.actorType} in ('user', 'bot', 'runner', 'external', 'system')`,
    ),
  ],
);
export type UsageEvent = typeof usageEvents.$inferSelect;

/**
 * A budget (spec §10's Phase 4 line "budgets"; task 4.2). §6 gives a budget to a virtual key and
 * to a bot's spec; this is the one a workspace sets for itself, for a person, or for a bot — the
 * ceiling everything under it is counted against (ADR-0148).
 */
export const BUDGET_SUBJECTS = ["workspace", "user", "bot"] as const;
export type BudgetSubject = (typeof BUDGET_SUBJECTS)[number];

/** The stretch a limit is counted over. */
export const BUDGET_PERIODS = ["day", "month", "total"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const budgets = pgTable(
  "budgets",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").$type<BudgetSubject>().notNull(),
    /**
     * Who it is about: the person, the bot, or — for a workspace's own budget — the workspace.
     * Never null, because a unique index over a nullable column lets two of them exist.
     */
    subjectId: uuid("subject_id").notNull(),
    limitUsd: numeric("limit_usd", { precision: 12, scale: 6 }).notNull(),
    period: text("period").$type<BudgetPeriod>().notNull().default("month"),
    /**
     * The fraction of the limit that is worth a word before it is reached — 0.8 is "tell me at
     * eighty percent". Zero means no warning, only the stop.
     */
    warnAt: numeric("warn_at", { precision: 4, scale: 3 }).notNull().default("0.8"),
    ...timestamps(),
  },
  (t) => [
    // One budget per subject per workspace: two ceilings for one thing is a question, not a rule.
    uniqueIndex("budgets_subject_idx").on(t.workspaceId, t.subjectType, t.subjectId),
    check("budgets_subject_check", sql`${t.subjectType} in ('workspace', 'user', 'bot')`),
    check("budgets_period_check", sql`${t.period} in ('day', 'month', 'total')`),
  ],
);
export type Budget = typeof budgets.$inferSelect;
