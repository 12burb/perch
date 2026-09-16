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
} from "drizzle-orm/pg-core";
import { id, timestamps, timestamptz } from "../columns.ts";
import type { ViewDisplay, ViewFilters, WorkItemDescription } from "../shapes/index.ts";
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

/** Where a cycle is in its life: planned, running now, or over (spec §6 `cycles.status`). */
export const CYCLE_STATUSES = ["planned", "active", "closed"] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

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
    status: text("status").$type<CycleStatus>().notNull().default("planned"),
    ...timestamps(),
  },
  (t) => [
    index("cycles_project_idx").on(t.projectId, t.startsAt),
    check("cycles_status_check", sql`${t.status} in ('planned', 'active', 'closed')`),
  ],
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
    /**
     * When it reached `done` or `cancelled`, cleared if it comes back out (task 3.26). A burndown
     * is a question about the past — how much was left on Tuesday — and `updated_at` cannot answer
     * it, because editing a finished item's title would move the line.
     */
    completedAt: timestamptz("completed_at"),
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

/**
 * How two items are related (spec §6 `work_item_relations`; task 3.26). `blocks` and `blocked_by`
 * are the same fact from both ends, and Perch writes both rows: a person who opens the blocked one
 * should not have to know which end it was entered from.
 */
export const WORK_RELATION_KINDS = ["blocks", "blocked_by", "relates", "duplicates"] as const;
export type WorkRelationKind = (typeof WORK_RELATION_KINDS)[number];

export const workItemRelations = pgTable(
  "work_item_relations",
  {
    id: id(),
    workItemId: uuid("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    relatedId: uuid("related_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    kind: text("kind").$type<WorkRelationKind>().notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("work_item_relations_idx").on(t.workItemId, t.relatedId, t.kind),
    index("work_item_relations_related_idx").on(t.relatedId),
    check(
      "work_item_relations_kind_check",
      sql`${t.kind} in ('blocks', 'blocked_by', 'relates', 'duplicates')`,
    ),
  ],
);

/** The five layouts of §4. A view is one of them plus what it is about. */
export const VIEW_LAYOUTS = ["board", "list", "calendar", "timeline", "spreadsheet"] as const;
export type ViewLayout = (typeof VIEW_LAYOUTS)[number];

/**
 * A saved view (spec §6 `saved_views`; task 3.26): a layout, what to filter by, and what to show.
 * `owner_id` is who made it and `shared` is whether anybody else sees it — a view is somebody's
 * way of looking at the work before it is the team's.
 */
export const savedViews = pgTable(
  "saved_views",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id"),
    name: text("name").notNull(),
    layout: text("layout").$type<ViewLayout>().notNull().default("board"),
    filters: jsonb("filters").$type<ViewFilters>().notNull().default({}),
    display: jsonb("display").$type<ViewDisplay>().notNull().default({}),
    shared: boolean("shared").notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    index("saved_views_project_idx").on(t.projectId, t.name),
    index("saved_views_workspace_idx").on(t.workspaceId, t.name),
    check(
      "saved_views_layout_check",
      sql`${t.layout} in ('board', 'list', 'calendar', 'timeline', 'spreadsheet')`,
    ),
  ],
);

export type WorkItem = typeof workItems.$inferSelect;
export type NewWorkItem = typeof workItems.$inferInsert;
export type Cycle = typeof cycles.$inferSelect;
export type Module = typeof modules.$inferSelect;
export type WorkItemRelation = typeof workItemRelations.$inferSelect;
export type SavedView = typeof savedViews.$inferSelect;
