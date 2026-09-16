/**
 * Race mode (spec §5.7 "same task on two engines/models side by side; compare diffs, cost,
 * preflight; pick a winner"; task 3.16).
 *
 * A race is one task asked of several engines at once. Each entrant is an ordinary session in an
 * ordinary worktree — task 3.14's isolation is what makes a race possible at all — and what this
 * adds is the bookkeeping: who is running, what each one cost, what the checks said, and which
 * one won. The winner's branch goes to the merge queue; the rest are given back.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps, timestamptz } from "../columns.ts";
import { projects } from "./projects.ts";
import { codingSessions } from "./sessions.ts";
import { workspaces } from "./tenancy.ts";
import { workItems } from "./work.ts";

/** running while anybody is still working; decided once a winner is picked; cancelled otherwise. */
export const RACE_STATES = ["running", "decided", "cancelled"] as const;
export type RaceState = (typeof RACE_STATES)[number];

/** An entrant is working, done, or it fell over. `discarded` is a loser given back. */
export const ENTRANT_STATES = ["running", "finished", "failed", "discarded", "won"] as const;
export type EntrantState = (typeof ENTRANT_STATES)[number];

/** Who decided: a person chose, or the project's checks did. */
export const RACE_DECIDERS = ["person", "checks"] as const;
export type RaceDecider = (typeof RACE_DECIDERS)[number];

export const races = pgTable(
  "races",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workItemId: uuid("work_item_id").references(() => workItems.id, { onDelete: "set null" }),
    /** What every entrant was asked, word for word: a race is only fair if the ask is the same. */
    prompt: text("prompt").notNull(),
    state: text("state").$type<RaceState>().notNull().default("running"),
    decidedBy: text("decided_by").$type<RaceDecider>(),
    decidedByUserId: uuid("decided_by_user_id"),
    winnerId: uuid("winner_id"),
    /** The thread the race reports in, and the card it rewrites in place. */
    threadRootId: uuid("thread_root_id"),
    cardMessageId: uuid("card_message_id"),
    createdBy: uuid("created_by"),
    decidedAt: timestamptz("decided_at"),
    ...timestamps(),
  },
  (t) => [
    index("races_project_idx").on(t.projectId, t.state),
    index("races_item_idx").on(t.workItemId),
    check("races_state_check", sql`${t.state} in ('running', 'decided', 'cancelled')`),
  ],
);

export const raceEntrants = pgTable(
  "race_entrants",
  {
    id: id(),
    raceId: uuid("race_id")
      .notNull()
      .references(() => races.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => codingSessions.id, { onDelete: "set null" }),
    /** Which engine ran it, which is what the entrant is called on the card. */
    engine: text("engine").notNull(),
    /** Which program that engine ran, when the engine takes one (an ACP agent, a CLI). */
    agent: text("agent"),
    branch: text("branch").notNull(),
    state: text("state").$type<EntrantState>().notNull().default("running"),
    /** What the session spent, copied here when it finishes so a decided race stops moving. */
    costUsd: numeric("cost_usd"),
    /** What the diff came to: the three numbers a person compares at a glance. */
    filesChanged: integer("files_changed"),
    additions: integer("additions"),
    deletions: integer("deletions"),
    /** What the project's checks said about this entrant's branch. Null when it has none. */
    checksExitCode: integer("checks_exit_code"),
    checksOutput: text("checks_output"),
    /** Why it fell over, when it did. Never a credential. */
    detail: text("detail"),
    finishedAt: timestamptz("finished_at"),
    ...timestamps(),
  },
  (t) => [
    // One engine enters a race once: two entrants on one engine is two races.
    uniqueIndex("race_entrants_engine_idx").on(t.raceId, t.engine, t.branch),
    index("race_entrants_race_idx").on(t.raceId, t.state),
    index("race_entrants_session_idx").on(t.sessionId),
    check(
      "race_entrants_state_check",
      sql`${t.state} in ('running', 'finished', 'failed', 'discarded', 'won')`,
    ),
  ],
);

export type Race = typeof races.$inferSelect;
export type NewRace = typeof races.$inferInsert;
export type RaceEntrant = typeof raceEntrants.$inferSelect;
export type NewRaceEntrant = typeof raceEntrants.$inferInsert;
