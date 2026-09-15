/**
 * Brains (spec §3.4, §6 provider_credentials and model_profiles; task 1.15): where a model comes
 * from and what it costs. A credential is an API key or an OpenAI-compatible endpoint, encrypted
 * with the vault and never read back out to a client. A model profile names a provider, a model,
 * and the credential to use, so a session or a bot can say "run on this brain" without holding a
 * key. The catalog of models itself is not a table: each provider is asked for its own list when
 * a credential is tested or a model is picked (ADR-0081).
 */
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bytea, id, timestamps } from "../columns.ts";
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

/** What a profile is the default for, when it is one (spec §3.4). */
export const PROFILE_DEFAULTS = ["chat", "code"] as const;
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
    defaultFor: text("default_for").$type<ProfileDefault>(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("model_profiles_workspace_name_idx").on(t.workspaceId, t.name),
    // One default per kind per workspace; a second one takes the title by clearing the first.
    uniqueIndex("model_profiles_default_idx")
      .on(t.workspaceId, t.defaultFor)
      .where(sql`${t.defaultFor} is not null`),
    check("model_profiles_default_for_check", sql`${t.defaultFor} in ('chat', 'code')`),
  ],
);
export type ModelProfile = typeof modelProfiles.$inferSelect;
export type NewModelProfile = typeof modelProfiles.$inferInsert;
