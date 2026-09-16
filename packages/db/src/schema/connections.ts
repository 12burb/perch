/**
 * Connections (spec §3.5, §6 connections, connection_grants, oauth_clients; task 1.16): how Perch
 * reaches a service on someone's behalf. A connection is a token — pasted, or obtained through
 * OAuth, or minted from a GitHub App installation — encrypted with the vault and never read back
 * out to a caller. A grant says which bot, automation, or session may use one, and an oauth_client
 * holds the app credentials an instance registered with a provider.
 */
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
import { bytea, id, timestamps, timestamptz } from "../columns.ts";
import { channels } from "./chat.ts";
import { users } from "./identity.ts";
import { workspaces } from "./tenancy.ts";

/** user: personal, and nobody else's session may use it; workspace: shared, admin-created (§3.5). */
export const CONNECTION_OWNERS = ["user", "workspace"] as const;
export type ConnectionOwner = (typeof CONNECTION_OWNERS)[number];

/**
 * How the token was obtained. `token` is the paste lane, always available; `oauth2` is a manifest's
 * plain OAuth2; `github_app` mints a short-lived installation token per use; `mcp_oauth` is the MCP
 * client-auth lane (task 2.14).
 */
export const CONNECTION_KINDS = ["mcp_oauth", "oauth2", "github_app", "token"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const CONNECTION_STATUSES = ["active", "invalid", "expired", "revoked"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** What a connection remembers beyond its secret: never anything that could stand in for one. */
export type ConnectionMetadata = {
  /** What the provider calls the account this connection speaks as. */
  account?: string;
  /** A GitHub App installation, so a token can be minted for it on demand. */
  installationId?: string;
  /** The api base to call, when the manifest's default is not it (an enterprise host). */
  apiBase?: string;
  /** The MCP server to proxy to, when the manifest's default is not it (task 1.17). */
  mcpUrl?: string;
  /** The last few characters of a pasted token, so two are tellable apart. Never the whole thing. */
  hint?: string;
  /** Which lane the client id came by (task 2.14): pre_registered, cimd, or dcr. */
  lane?: string;
  /** The authorization server this connection's token came from, so a refresh knows where to ask. */
  issuer?: string;
  tokenEndpoint?: string;
  /** The client id used, which is public in every lane; a secret, when there is one, is vaulted. */
  clientId?: string;
};

export const connections = pgTable(
  "connections",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerType: text("owner_type").$type<ConnectionOwner>().notNull().default("user"),
    /** Whose it is. Always set: a workspace connection is owned by the admin who added it. */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** github, vercel, supabase, … — the id of the manifest in connectors/. */
    provider: text("provider").notNull(),
    kind: text("kind").$type<ConnectionKind>().notNull().default("token"),
    /**
     * The secret, vault-encrypted: a pasted token, an OAuth access+refresh pair, or a GitHub App
     * private key. It leaves the vault only to reach the provider (AGENTS.md §1.6).
     */
    ciphertext: bytea("ciphertext").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    expiresAt: timestamptz("expires_at"),
    status: text("status").$type<ConnectionStatus>().notNull().default("active"),
    metadata: jsonb("metadata").$type<ConnectionMetadata>().notNull().default({}),
    lastRefreshedAt: timestamptz("last_refreshed_at"),
    ...timestamps(),
  },
  (t) => [
    index("connections_workspace_idx").on(t.workspaceId, t.provider),
    index("connections_owner_idx").on(t.ownerId),
    check("connections_owner_type_check", sql`${t.ownerType} in ('user', 'workspace')`),
    check(
      "connections_kind_check",
      sql`${t.kind} in ('mcp_oauth', 'oauth2', 'github_app', 'token')`,
    ),
    check(
      "connections_status_check",
      sql`${t.status} in ('active', 'invalid', 'expired', 'revoked')`,
    ),
  ],
);
export type Connection = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;

/** Who a grant is for (spec §6): a bot, an automation, or one agent session. */
export const GRANT_SUBJECTS = ["bot", "automation", "session"] as const;
export type GrantSubject = (typeof GRANT_SUBJECTS)[number];

export const connectionGrants = pgTable(
  "connection_grants",
  {
    id: id(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").$type<GrantSubject>().notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** Null means every tool the connection exposes; a list narrows it (task 1.17). */
    allowedTools: jsonb("allowed_tools").$type<string[]>(),
    channels: jsonb("channels").$type<string[]>(),
    /** On behalf of: a shared bot may use a personal connection only for the person who invoked it. */
    obo: boolean("obo").notNull().default(false),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("connection_grants_subject_idx").on(t.connectionId, t.subjectType, t.subjectId),
    check(
      "connection_grants_subject_type_check",
      sql`${t.subjectType} in ('bot', 'automation', 'session')`,
    ),
  ],
);
export type ConnectionGrant = typeof connectionGrants.$inferSelect;

/**
 * An app an instance registered with a provider (spec §6 oauth_clients): the pre-registered lane,
 * and where a GitHub App's id and private key live. A null workspace is the instance-wide default.
 */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: id(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** The provider's id for the app: an OAuth client id, or a GitHub App's app id. */
    clientId: text("client_id").notNull(),
    /** The client secret or the app's private key, vault-encrypted. */
    ciphertextSecret: bytea("ciphertext_secret"),
    redirectUri: text("redirect_uri").notNull(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("oauth_clients_workspace_provider_idx").on(t.workspaceId, t.provider)],
);
export type OauthClient = typeof oauthClients.$inferSelect;

/**
 * An inbound webhook (spec §3.5 "inbound webhooks at /hooks/:provider/:id with signature
 * verification → channel cards"; task 3.4).
 *
 * The row is the endpoint: a provider, a channel to post in, and the secret Perch generated for
 * whoever pasted it into the provider. The secret is vaulted like every other, because a webhook
 * secret is what lets somebody speak as the provider.
 */
export const webhooks = pgTable(
  "webhooks",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The manifest this delivery is verified against. */
    provider: text("provider").notNull(),
    /** What a person called it, so a list of endpoints is readable. */
    name: text("name").notNull(),
    /** Where the card goes. */
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** The connection this belongs to, when it came from one; a webhook can stand on its own. */
    connectionId: uuid("connection_id").references(() => connections.id, { onDelete: "set null" }),
    /** The signing secret, vault-encrypted, shown to a person exactly once. */
    ciphertext: bytea("ciphertext").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastDeliveryAt: timestamptz("last_delivery_at"),
    /** How many deliveries it has taken, which is the first thing anybody wants to know. */
    deliveries: integer("deliveries").notNull().default(0),
    status: text("status").$type<"active" | "paused">().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    index("webhooks_workspace_idx").on(t.workspaceId),
    check("webhooks_status_check", sql`${t.status} in ('active', 'paused')`),
  ],
);

export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;

/**
 * What has already been delivered, so the same delivery twice is one card (task 3.4). A provider
 * that never heard the 200 will send again; the second one is not news.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    /** The provider's own id for it. */
    deliveryId: text("delivery_id").notNull(),
    event: text("event"),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("webhook_deliveries_idx").on(t.webhookId, t.deliveryId),
    index("webhook_deliveries_received_idx").on(t.receivedAt),
  ],
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
