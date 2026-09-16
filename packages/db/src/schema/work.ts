/**
 * Work tracking (spec §6 `work_items`, `cycles`, `modules`; §4 "Work (Plane)"; task 3.13).
 *
 * A work item is the thing everything else in Perch points at: the thread it came from, the
 * session doing it, the pull request that finished it, the preview you can look at. Which is why
 * those live here as columns rather than as a join table — one row answers "what is happening
 * with this" without a query per link.
 *
 * `cycles` and `modules` ship with the same migration because `work_items` references them and a
 * shipped migration is never edited (AGENTS.md §7). What is built on them is task 3.13's
 * successors'; the columns are here so they do not need a second migration to arrive.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
import { id, timestamps, timestamptz } from "../columns.ts";
import type { WorkItemDescription } from "../shapes/index.ts";
import { projects } from "./projects.ts";
import { codingSessions } from "./sessions.ts";
import { workspaces } from "./tenancy.ts";

/** What kind of thing it is (spec §4). */
export const WORK_ITEM_TYPES = ["task", "bug", "feature", "epic"] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

/**
 * The seven states of §4, in the order a board shows them. `running` and `needs_you` are what
 * make this board different from every other one: they are where an agent is, and where it
 * stopped to ask.
 */
export const WORK_ITEM_STATES = [
  "backlog",
  "queued",
  "running",
  "needs_you",
  "in_review",
  "done",
  "cancelled",
] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

/** Who it is for. An engine+model assignee is spec §4's third kind and arrives with race mode. */
export const WORK_ASSIGNEES = ["user", "bot"] as const;
export type WorkAssignee = (typeof WORK_ASSIGNEES)[number];

/** Where it came from: typed in, made from a message, or raised by a bot or an agent. */
export const WORK_ITEM_SOURCES = ["manual", "message", "bot", "intake"] as const;
export type WorkItemSource = (typeof WORK_ITEM_SOURCES)[number];

export const cycles = pgTable(
  "cycles",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    startsAt: timestamptz("starts_at"),
    endsAt: timestamptz("ends_at"),
    status: text("status").notNull().default("planned"),
    ...timestamps(),
  },
  (t) => [index("cycles_project_idx").on(t.projectId, t.startsAt)],
);

export const modules = pgTable(
  "modules",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    startsAt: timestamptz("starts_at"),
    endsAt: timestamptz("ends_at"),
    ...timestamps(),
  },
  (t) => [index("modules_project_idx").on(t.projectId, t.name)],
);

export const workItems = pgTable(
  "work_items",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The number in `KEY-123`, counted per project and never reused (spec §7.8). */
    number: integer("number").notNull(),
    type: text("type").$type<WorkItemType>().notNull().default("task"),
    title: text("title").notNull(),
    description: jsonb("description").$type<WorkItemDescription>().notNull().default({ text: "" }),
    state: text("state").$type<WorkItemState>().notNull().default("backlog"),
    /** 0 none, 1 urgent … 4 low, the way §4's quick-add writes `p1`. */
    priority: integer("priority").notNull().default(0),
    assigneeType: text("assignee_type").$type<WorkAssignee>(),
    assigneeId: uuid("assignee_id"),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    cycleId: uuid("cycle_id").references(() => cycles.id, { onDelete: "set null" }),
    moduleId: uuid("module_id").references(() => modules.id, { onDelete: "set null" }),
    estimate: numeric("estimate"),
    dueAt: timestamptz("due_at"),
    parentId: uuid("parent_id").references((): AnyPgColumn => workItems.id, {
      onDelete: "set null",
    }),
    source: text("source").$type<WorkItemSource>().notNull().default("manual"),
    intakeStatus: text("intake_status"),
    /** The thread this came out of, so the conversation and the work stay one thing. */
    threadRootId: uuid("thread_root_id"),
    /** The session doing it. Set when one is started from here; cleared when it ends. */
    sessionId: uuid("session_id").references(() => codingSessions.id, { onDelete: "set null" }),
    prUrl: text("pr_url"),
    previewShareId: uuid("preview_share_id"),
    createdBy: uuid("created_by"),
    ...timestamps(),
  },
  (t) => [
    // `KEY-123` is a promise: one number per project, forever.
    uniqueIndex("work_items_number_idx").on(t.projectId, t.number),
    index("work_items_board_idx").on(t.projectId, t.state, t.priority),
    index("work_items_assignee_idx").on(t.workspaceId, t.assigneeType, t.assigneeId),
    index("work_items_session_idx").on(t.sessionId),
    check("work_items_type_check", sql`${t.type} in ('task', 'bug', 'feature', 'epic')`),
    check(
      "work_items_state_check",
      sql`${t.state} in ('backlog', 'queued', 'running', 'needs_you', 'in_review', 'done', 'cancelled')`,
    ),
    check(
      "work_items_assignee_check",
      sql`(${t.assigneeType} is null and ${t.assigneeId} is null)
          or (${t.assigneeType} in ('user', 'bot') and ${t.assigneeId} is not null)`,
    ),
    check("work_items_priority_check", sql`${t.priority} between 0 and 4`),
  ],
);

export type WorkItem = typeof workItems.$inferSelect;
export type NewWorkItem = typeof workItems.$inferInsert;
export type Cycle = typeof cycles.$inferSelect;
export type Module = typeof modules.$inferSelect;
