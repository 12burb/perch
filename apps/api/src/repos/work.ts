/**
 * work_items (spec §6; task 3.13). One row is one piece of work, and the columns that point
 * outward — thread, session, pull request — are what make the board a view of what is actually
 * happening rather than a list somebody maintains by hand.
 */
import type { Db, NewWorkItem, WorkItem, WorkItemState } from "@perch/db";
import { schema } from "@perch/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

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
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("work_items_number_idx")) throw error;
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
};

/**
 * A project's board, ordered the way it is read: urgent first within a column, then oldest first,
 * so the thing that has waited longest is the thing at the top.
 */
export async function listWorkItems(
  db: Db,
  projectId: string,
  options: BoardOptions = {},
): Promise<WorkItem[]> {
  const where = [eq(workItems.projectId, projectId)];
  if (options.states?.length) where.push(inArray(workItems.state, [...options.states]));
  if (options.assigneeId) where.push(eq(workItems.assigneeId, options.assigneeId));
  return db
    .select()
    .from(workItems)
    .where(and(...where))
    .orderBy(desc(workItems.priority), asc(workItems.createdAt))
    .limit(Math.min(options.limit ?? 500, 1000));
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

/** The item a session is doing, when a session was started from one. */
export async function workItemForSession(db: Db, sessionId: string): Promise<WorkItem | null> {
  const [row] = await db
    .select()
    .from(workItems)
    .where(eq(workItems.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}
