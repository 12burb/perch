/**
 * work_items (spec §6; task 3.13). One row is one piece of work, and the columns that point
 * outward — thread, session, pull request — are what make the board a view of what is actually
 * happening rather than a list somebody maintains by hand.
 */
import type {
  Db,
  NewWorkItem,
  ViewDisplay,
  ViewFilters,
  WorkItem,
  WorkItemState,
  WorkItemType,
} from "@perch/db";
import { schema } from "@perch/db";
import { and, asc, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { isUniqueViolation } from "../errors.ts";

const { workItems } = schema;

/**
 * The next number in this project, allocated in the insert itself so two people adding at once
 * cannot both take 7. `KEY-123` is a promise the unique index keeps; this is how it is kept
 * without a sequence per project.
 */
export async function insertWorkItem(
  db: Db,
  values: Omit<NewWorkItem, "number">,
): Promise<WorkItem> {
  // One retry: the subquery and the insert are not one statement under read-committed, so two
  // writers can read the same max. The second gets the unique violation and takes the next one.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db
        .insert(workItems)
        .values({
          ...values,
          number: sql`(select coalesce(max(${workItems.number}), 0) + 1 from ${workItems} where ${workItems.projectId} = ${sql.param(values.projectId, workItems.projectId)})`,
        })
        .returning();
      if (!row) throw new Error("work item insert returned no row");
      return row;
    } catch (error) {
      if (!isUniqueViolation(error, "work_items_number_idx")) throw error;
    }
  }
  throw new Error("could not allocate a work item number");
}

export async function getWorkItem(db: Db, id: string): Promise<WorkItem | null> {
  const [row] = await db.select().from(workItems).where(eq(workItems.id, id)).limit(1);
  return row ?? null;
}

/** By its `KEY-123` number, which is how a person or a bot refers to one. */
export async function workItemByNumber(
  db: Db,
  projectId: string,
  number: number,
): Promise<WorkItem | null> {
  const [row] = await db
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.number, sql.param(number, workItems.number)),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type BoardOptions = {
  states?: readonly WorkItemState[] | undefined;
  assigneeId?: string | undefined;
  limit?: number | undefined;
  /** Everything a saved view can narrow by (spec §4; task 3.26). */
  types?: readonly WorkItemType[] | undefined;
  priorities?: readonly number[] | undefined;
  labels?: readonly string[] | undefined;
  assignees?: readonly string[] | undefined;
  cycleId?: string | null | undefined;
  moduleId?: string | null | undefined;
  search?: string | undefined;
  /** A view can leave sub-items out, so a list of everything shows each thing once. */
  hideSubItems?: boolean | undefined;
  orderBy?: ViewDisplay["orderBy"] | undefined;
  direction?: ViewDisplay["direction"] | undefined;
};

/** `%` and `_` mean something in `like`, and a person typing them means the characters. */
function literal(term: string): string {
  return term.replace(/[\\%_]/g, (one) => `\\${one}`);
}

/** What a view is about, as a where clause (task 3.26). */
function narrow(options: BoardOptions): SQL[] {
  const where: SQL[] = [];
  if (options.states?.length) where.push(inArray(workItems.state, [...options.states]));
  if (options.types?.length) where.push(inArray(workItems.type, [...options.types]));
  if (options.priorities?.length) where.push(inArray(workItems.priority, [...options.priorities]));
  if (options.assigneeId) where.push(eq(workItems.assigneeId, options.assigneeId));
  if (options.assignees?.length) where.push(inArray(workItems.assigneeId, [...options.assignees]));
  if (options.labels?.length) {
    // Any of them: a view for `bug` and `p1` is about items carrying either label.
    const each = options.labels.map(
      (label) => sql`${workItems.labels} @> ${JSON.stringify([label])}::jsonb`,
    );
    const any = each.length === 1 ? each[0] : or(...each);
    if (any) where.push(any);
  }
  if (options.cycleId === null) where.push(isNull(workItems.cycleId));
  else if (options.cycleId) where.push(eq(workItems.cycleId, options.cycleId));
  if (options.moduleId === null) where.push(isNull(workItems.moduleId));
  else if (options.moduleId) where.push(eq(workItems.moduleId, options.moduleId));
  if (options.search?.trim())
    where.push(ilike(workItems.title, `%${literal(options.search.trim())}%`));
  if (options.hideSubItems) where.push(isNull(workItems.parentId));
  return where;
}

/** How a view is sorted. The default is the board's: urgent first, then oldest first. */
function ordering(options: BoardOptions): SQL[] {
  const down = options.direction !== "asc";
  switch (options.orderBy) {
    case "created":
      return [down ? desc(workItems.createdAt) : asc(workItems.createdAt)];
    case "updated":
      return [down ? desc(workItems.updatedAt) : asc(workItems.updatedAt)];
    case "due":
      // Nulls last either way: an item with no date is not the most urgent thing in the list.
      return [sql`${workItems.dueAt} ${sql.raw(down ? "desc" : "asc")} nulls last`];
    case "title":
      return [options.direction === "desc" ? desc(workItems.title) : asc(workItems.title)];
    default:
      return [desc(workItems.priority), asc(workItems.createdAt)];
  }
}

/** The filters a saved view stores, as the options this repository takes. */
export function optionsFrom(filters: ViewFilters, display: ViewDisplay): BoardOptions {
  return {
    ...(filters.states?.length ? { states: filters.states as WorkItemState[] } : {}),
    ...(filters.types?.length ? { types: filters.types as WorkItemType[] } : {}),
    ...(filters.priorities?.length ? { priorities: filters.priorities } : {}),
    ...(filters.labels?.length ? { labels: filters.labels } : {}),
    ...(filters.assignees?.length ? { assignees: filters.assignees } : {}),
    ...(filters.cycleId === undefined ? {} : { cycleId: filters.cycleId }),
    ...(filters.moduleId === undefined ? {} : { moduleId: filters.moduleId }),
    ...(filters.search ? { search: filters.search } : {}),
    ...(display.showSubItems === false ? { hideSubItems: true } : {}),
    ...(display.orderBy ? { orderBy: display.orderBy } : {}),
    ...(display.direction ? { direction: display.direction } : {}),
  };
}

/**
 * A project's board, ordered the way it is read: urgent first within a column, then oldest first,
 * so the thing that has waited longest is the thing at the top.
 */
export async function listWorkItems(
  db: Db,
  projectId: string,
  options: BoardOptions = {},
): Promise<WorkItem[]> {
  return db
    .select()
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), ...narrow(options)))
    .orderBy(...ordering(options))
    .limit(Math.min(options.limit ?? 500, 1000));
}

/**
 * The triage queue (spec §4 "Intake triage queue"): what arrived from somewhere other than a
 * person typing it, and has not been accepted or declined yet (task 3.26).
 */
export async function listIntake(db: Db, projectId: string, limit = 200): Promise<WorkItem[]> {
  return db
    .select()
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), eq(workItems.intakeStatus, "pending")))
    .orderBy(desc(workItems.priority), asc(workItems.createdAt))
    .limit(Math.min(limit, 500));
}

/** Everything in one cycle, which is what a burndown is counted from. */
export async function itemsInCycle(db: Db, cycleId: string): Promise<WorkItem[]> {
  return db
    .select()
    .from(workItems)
    .where(eq(workItems.cycleId, cycleId))
    .orderBy(asc(workItems.number));
}

/** Moves a closed cycle's unfinished work on, and says how much there was. */
export async function carryOver(
  db: Db,
  cycleId: string,
  toCycleId: string | null,
): Promise<number> {
  const rows = await db
    .update(workItems)
    .set({ cycleId: toCycleId, updatedAt: new Date() })
    .where(
      and(
        eq(workItems.cycleId, cycleId),
        inArray(workItems.state, ["backlog", "queued", "running", "needs_you", "in_review"]),
      ),
    )
    .returning({ id: workItems.id });
  return rows.length;
}

export async function updateWorkItem(
  db: Db,
  id: string,
  patch: Partial<Omit<NewWorkItem, "id" | "number" | "projectId" | "workspaceId">>,
): Promise<WorkItem | null> {
  const [row] = await db
    .update(workItems)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(workItems.id, id))
    .returning();
  return row ?? null;
}

/**
 * Points an item at the session doing it — only if no session is doing it already. The condition is
 * the claim: of two starts at once, one update finds the column empty and the other finds nothing to
 * change, however their reads interleaved (X-data-18).
 */
export async function claimWorkItem(
  db: Db,
  id: string,
  sessionId: string,
): Promise<WorkItem | null> {
  const [row] = await db
    .update(workItems)
    .set({ sessionId, state: "running", updatedAt: new Date() })
    .where(and(eq(workItems.id, id), isNull(workItems.sessionId)))
    .returning();
  return row ?? null;
}

/** The item a session is doing, when a session was started from one. */
export async function workItemForSession(db: Db, sessionId: string): Promise<WorkItem | null> {
  const [row] = await db
    .select()
    .from(workItems)
    .where(eq(workItems.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}
