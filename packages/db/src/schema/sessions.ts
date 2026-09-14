/**
 * Sessions (spec §6 coding_sessions, session_events, session_checkpoints; task 1.8, ADR-0074): an
 * agent session in a project, every event of its transcript with a monotonic seq, and the git
 * checkpoints taken per turn. The model columns beyond the spec's model_profile_id carry the
 * provider and model id a session was opened with, so a transcript stays readable after a profile
 * changes.
 */
import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps, timestamptz } from "../columns.ts";
import { users } from "./identity.ts";
import { projects, runners } from "./projects.ts";
import { workspaces } from "./tenancy.ts";

export const SESSION_MODES = ["plan", "build"] as const;
export type SessionModeValue = (typeof SESSION_MODES)[number];
/** idle between rounds → running → needs_you (a permission waits) → idle | error; ended once closed. */
export const CODING_SESSION_STATUSES = ["idle", "running", "needs_you", "error", "ended"] as const;
export type CodingSessionStatus = (typeof CODING_SESSION_STATUSES)[number];

/** A stored transcript event: an EngineEvent or a person's turn (@perch/events sessionEventSchema). */
export type StoredSessionEvent = { type: string } & Record<string, unknown>;

export const codingSessions = pgTable(
  "coding_sessions",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runnerId: uuid("runner_id").references(() => runners.id, { onDelete: "set null" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    engine: text("engine").notNull(),
    engineSessionId: text("engine_session_id"),
    modelProvider: text("model_provider").notNull(),
    modelId: text("model_id").notNull(),
    // References model_profiles once the brains group lands (task 1.15); until then a bare uuid.
    modelProfileId: uuid("model_profile_id"),
    mode: text("mode").$type<SessionModeValue>().notNull().default("build"),
    status: text("status").$type<CodingSessionStatus>().notNull().default("idle"),
    title: text("title"),
    worktree: text("worktree"),
    branch: text("branch"),
    workItemId: uuid("work_item_id"),
    threadRootId: uuid("thread_root_id"),
    /** The session this one was forked from (task 1.12): its transcript was copied at the fork. */
    forkedFromId: uuid("forked_from_id"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    /** Rounds sent so far; a checkpoint is per turn. */
    turns: integer("turns").notNull().default(0),
    /** The last seq handed out for session_events; bumped atomically per event. */
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
    /** Why the session is in error, when it is; never a credential. */
    statusMessage: text("status_message"),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    endedAt: timestamptz("ended_at"),
    ...timestamps(),
  },
  (t) => [
    index("coding_sessions_project_idx").on(t.projectId, t.startedAt),
    index("coding_sessions_workspace_idx").on(t.workspaceId, t.startedAt),
  ],
);
export type CodingSession = typeof codingSessions.$inferSelect;
export type NewCodingSession = typeof codingSessions.$inferInsert;

export const sessionEvents = pgTable(
  "session_events",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => codingSessions.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    event: jsonb("event").$type<StoredSessionEvent>().notNull(),
    ts: timestamptz("ts").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);
export type SessionEventRow = typeof sessionEvents.$inferSelect;

export const sessionCheckpoints = pgTable(
  "session_checkpoints",
  {
    id: id(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => codingSessions.id, { onDelete: "cascade" }),
    turn: integer("turn").notNull(),
    gitRef: text("git_ref").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("session_checkpoints_turn_idx").on(t.sessionId, t.turn)],
);
export type SessionCheckpoint = typeof sessionCheckpoints.$inferSelect;
