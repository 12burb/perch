/**
 * The merge queue (spec §5.7 "merge queue with rebase, conflict detection, 'ask the agent to
 * resolve'"; task 3.15).
 *
 * One row is one branch waiting its turn on one project. The queue is the order the rows were
 * made in, and the state machine is short on purpose: a branch is waiting, it is landing, and then
 * it either landed or it did not and somebody — usually the agent that wrote it — has to do
 * something about it.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
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

/** waiting → landing → landed | failed. `cancelled` is somebody taking it out of the queue. */
export const MERGE_STATES = ["waiting", "landing", "landed", "failed", "cancelled"] as const;
export type MergeState = (typeof MERGE_STATES)[number];

/** Why it did not land, which decides what the card says and what the agent is asked. */
export const MERGE_FAILURES = ["conflict", "checks", "runner"] as const;
export type MergeFailure = (typeof MERGE_FAILURES)[number];

export const mergeQueueEntries = pgTable(
  "merge_queue_entries",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The work item this branch is for, when it came from the board. */
    workItemId: uuid("work_item_id").references(() => workItems.id, { onDelete: "set null" }),
    /** The session that wrote it, so a failure can be handed back to the agent that caused it. */
    sessionId: uuid("session_id").references(() => codingSessions.id, { onDelete: "set null" }),
    branch: text("branch").notNull(),
    /** What it lands on. The project's default branch unless somebody said otherwise. */
    base: text("base").notNull(),
    state: text("state").$type<MergeState>().notNull().default("waiting"),
    /** Position in the queue: the order they were added, and never reused. */
    position: integer("position").notNull(),
    failure: text("failure").$type<MergeFailure>(),
    /** git's words or the check command's output, trimmed. Never a credential. */
    detail: text("detail"),
    /** What the checks did: the command, its exit code, and the tail of what it said. */
    checks: jsonb("checks").$type<{ command: string; exitCode: number | null; output: string }>(),
    /** The commit the base moved to, when it landed. */
    head: text("head"),
    /** The thread the queue card lives in, and the card itself, so it is rewritten in place. */
    threadRootId: uuid("thread_root_id"),
    cardMessageId: uuid("card_message_id"),
    requestedBy: uuid("requested_by"),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("merge_queue_position_idx").on(t.projectId, t.position),
    index("merge_queue_state_idx").on(t.projectId, t.state, t.position),
    index("merge_queue_item_idx").on(t.workItemId),
    check(
      "merge_queue_state_check",
      sql`${t.state} in ('waiting', 'landing', 'landed', 'failed', 'cancelled')`,
    ),
  ],
);

export type MergeQueueEntry = typeof mergeQueueEntries.$inferSelect;
export type NewMergeQueueEntry = typeof mergeQueueEntries.$inferInsert;
