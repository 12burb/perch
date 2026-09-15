/**
 * Bots (spec §6 `bots`, `bot_installs`, `bot_runs`, `bot_memories`; §5.3; task 2.6).
 *
 * A bot is a member of the workspace that happens not to be a person: it has a handle people type
 * after an `@`, a spec that says how it behaves, an owner who answers for it, and a ledger of what
 * it has spent. Everything it can do is in the spec; everything it has done is in `bot_runs`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { citext, id, timestamps, timestamptz } from "../columns.ts";
import type { BotBudget, BotInstallScopes, BotMemoryMetadata, BotSpec } from "../shapes/index.ts";
import { channels, messages } from "./chat.ts";
import { users } from "./identity.ts";
import { workspaces } from "./tenancy.ts";

/** How a bot was made (spec §5.3 "four ways to make one"). */
export const BOT_LEVELS = ["ui", "spec", "code", "external"] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];

export const BOT_VISIBILITIES = ["private", "workspace"] as const;
export type BotVisibility = (typeof BOT_VISIBILITIES)[number];

export const BOT_STATUSES = ["active", "paused", "disabled"] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

export const bots = pgTable(
  "bots",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** What people type after an `@`; case-insensitive, like a person's. */
    handle: citext("handle").notNull(),
    name: text("name").notNull(),
    level: text("level").$type<BotLevel>().notNull().default("ui"),
    /** Persona, brain, tools, triggers, scope, memory and rate limit: the whole of how it behaves. */
    spec: jsonb("spec").$type<BotSpec>().notNull().default({}),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    visibility: text("visibility").$type<BotVisibility>().notNull().default("private"),
    /** An orchestrator may tag other bots (spec §5.4; task 2.7). */
    orchestrator: boolean("orchestrator").notNull().default(false),
    budget: jsonb("budget").$type<BotBudget>().notNull().default({}),
    status: text("status").$type<BotStatus>().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("bots_workspace_handle_idx").on(t.workspaceId, t.handle),
    check("bots_level_check", sql`${t.level} in ('ui', 'spec', 'code', 'external')`),
    check("bots_visibility_check", sql`${t.visibility} in ('private', 'workspace')`),
    check("bots_status_check", sql`${t.status} in ('active', 'paused', 'disabled')`),
  ],
);

/** Where a bot has been put, and what it may do there. */
export const botInstalls = pgTable(
  "bot_installs",
  {
    id: id(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    scopes: jsonb("scopes").$type<BotInstallScopes>().notNull().default({}),
    /** On behalf of: the bot uses the caller's connections rather than its own (spec §6). */
    obo: boolean("obo").notNull().default(false),
    ...timestamps(),
  },
  (t) => [uniqueIndex("bot_installs_bot_channel_idx").on(t.botId, t.channelId)],
);

export const BOT_RUN_STATUSES = ["running", "done", "error", "refused"] as const;
export type BotRunStatus = (typeof BOT_RUN_STATUSES)[number];

/** One turn of one bot: what set it off, what it cost, and how it ended. */
export const botRuns = pgTable(
  "bot_runs",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    /** The trigger that fired: mention, dm, keyword, channel_join, reaction, schedule, webhook, test. */
    trigger: text("trigger").notNull(),
    /** What it fired on: a message id, a channel id, a cron key. */
    triggerRef: text("trigger_ref"),
    status: text("status").$type<BotRunStatus>().notNull().default("running"),
    engine: text("engine"),
    modelId: text("model_id"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    endedAt: timestamptz("ended_at"),
    error: text("error"),
    ...timestamps(),
  },
  (t) => [
    index("bot_runs_bot_started_idx").on(t.botId, t.startedAt.desc()),
    index("bot_runs_workspace_started_idx").on(t.workspaceId, t.startedAt.desc()),
    check("bot_runs_status_check", sql`${t.status} in ('running', 'done', 'error', 'refused')`),
  ],
);

/** What a bot chose to keep (spec §5.3 `remember`/`recall`). */
export const botMemories = pgTable(
  "bot_memories",
  {
    id: id(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    /** Where it applies: `global`, a channel id, or a thread root id. */
    scope: text("scope").notNull().default("global"),
    content: text("content").notNull(),
    /**
     * Null when the bot's provider has no embedding model configured: recall falls back to the
     * words themselves rather than pretending to a vector it never computed (ADR-0096).
     */
    embedding: vector("embedding", { dimensions: 1024 }),
    metadata: jsonb("metadata").$type<BotMemoryMetadata>().notNull().default({}),
    /** The message that caused it, when one did. */
    sourceMessageId: uuid("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    ...timestamps(),
  },
  (t) => [
    index("bot_memories_bot_scope_idx").on(t.botId, t.scope),
    index("bot_memories_embedding_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
      .where(sql`${t.embedding} is not null`),
  ],
);

/** How one bot tags another (spec §5.4). */
export const CHAIN_MODES = ["consult", "handoff", "fanout"] as const;
export type ChainMode = (typeof CHAIN_MODES)[number];

export const CHAIN_STATUSES = ["running", "done", "error", "refused"] as const;
export type ChainStatus = (typeof CHAIN_STATUSES)[number];

/**
 * One hop of one chain (spec §5.4 "every hop audited (bot_chains)"; task 2.7): who tagged whom,
 * how far from the request that started it, what it cost, and — when the rails stopped it — why.
 */
export const botChains = pgTable(
  "bot_chains",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The message that started the whole thing: a person's, a schedule's, a webhook's. */
    rootMessageId: uuid("root_message_id").references(() => messages.id, { onDelete: "set null" }),
    threadRootId: uuid("thread_root_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    hop: integer("hop").notNull().default(1),
    fromType: text("from_type").$type<"user" | "bot" | "system">().notNull(),
    fromId: uuid("from_id").notNull(),
    toBotId: uuid("to_bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    mode: text("mode").$type<ChainMode>().notNull().default("consult"),
    status: text("status").$type<ChainStatus>().notNull().default("running"),
    tokens: integer("tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    /** Why the rails stopped here: the hop limit, a repeat pair, the thread's budget. */
    breakerReason: text("breaker_reason"),
    ...timestamps(),
  },
  (t) => [
    index("bot_chains_thread_idx").on(t.threadRootId, t.createdAt),
    index("bot_chains_workspace_idx").on(t.workspaceId, t.createdAt.desc()),
    check("bot_chains_mode_check", sql`${t.mode} in ('consult', 'handoff', 'fanout')`),
    check("bot_chains_status_check", sql`${t.status} in ('running', 'done', 'error', 'refused')`),
    check("bot_chains_from_type_check", sql`${t.fromType} in ('user', 'bot', 'system')`),
  ],
);

export type Bot = typeof bots.$inferSelect;
export type NewBot = typeof bots.$inferInsert;
export type BotInstall = typeof botInstalls.$inferSelect;
export type BotRun = typeof botRuns.$inferSelect;
export type NewBotRun = typeof botRuns.$inferInsert;
export type BotMemory = typeof botMemories.$inferSelect;
export type NewBotMemory = typeof botMemories.$inferInsert;
export type BotChain = typeof botChains.$inferSelect;
export type NewBotChain = typeof botChains.$inferInsert;
