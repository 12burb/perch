/**
 * merge_queue_entries (spec §5.7; task 3.15). The queue is the order the rows were made in, so
 * the position is allocated the way a work item's number is: inside the insert, with the unique
 * index as the arbiter.
 */
import type { Db, MergeQueueEntry, MergeState, NewMergeQueueEntry } from "@perch/db";
import { schema } from "@perch/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

const { mergeQueueEntries } = schema;

export async function enqueue(
  db: Db,
  values: Omit<NewMergeQueueEntry, "position">,
): Promise<MergeQueueEntry> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db
        .insert(mergeQueueEntries)
        .values({
          ...values,
          position: sql`(select coalesce(max(${mergeQueueEntries.position}), 0) + 1 from ${mergeQueueEntries} where ${mergeQueueEntries.projectId} = ${sql.param(values.projectId, mergeQueueEntries.projectId)})`,
        })
        .returning();
      if (!row) throw new Error("merge queue insert returned no row");
      return row;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("merge_queue_position_idx")) throw error;
    }
  }
  throw new Error("could not take a place in the queue");
}

export async function getEntry(db: Db, id: string): Promise<MergeQueueEntry | null> {
  const [row] = await db
    .select()
    .from(mergeQueueEntries)
    .where(eq(mergeQueueEntries.id, id))
    .limit(1);
  return row ?? null;
}

/** The whole queue for a project, in the order it will be worked. */
export async function listQueue(
  db: Db,
  projectId: string,
  states?: readonly MergeState[],
): Promise<MergeQueueEntry[]> {
  const where = [eq(mergeQueueEntries.projectId, projectId)];
  if (states?.length) where.push(inArray(mergeQueueEntries.state, [...states]));
  return db
    .select()
    .from(mergeQueueEntries)
    .where(and(...where))
    .orderBy(asc(mergeQueueEntries.position))
    .limit(200);
}

/**
 * The next branch to land, claimed so that two api processes cannot both land it. The update is
 * the lock: only one of them changes a row from waiting to landing.
 */
export async function claimNext(db: Db, projectId: string): Promise<MergeQueueEntry | null> {
  const [next] = await db
    .select({ id: mergeQueueEntries.id })
    .from(mergeQueueEntries)
    .where(and(eq(mergeQueueEntries.projectId, projectId), eq(mergeQueueEntries.state, "waiting")))
    .orderBy(asc(mergeQueueEntries.position))
    .limit(1);
  if (!next) return null;
  const [claimed] = await db
    .update(mergeQueueEntries)
    .set({ state: "landing", startedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(mergeQueueEntries.id, next.id), eq(mergeQueueEntries.state, "waiting")))
    .returning();
  return claimed ?? null;
}

/** True while something is already landing on this project: a queue lands one at a time. */
export async function landing(db: Db, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: mergeQueueEntries.id })
    .from(mergeQueueEntries)
    .where(and(eq(mergeQueueEntries.projectId, projectId), eq(mergeQueueEntries.state, "landing")))
    .limit(1);
  return Boolean(row);
}

export async function updateEntry(
  db: Db,
  id: string,
  patch: Partial<Omit<NewMergeQueueEntry, "id" | "position" | "projectId" | "workspaceId">>,
): Promise<MergeQueueEntry | null> {
  const [row] = await db
    .update(mergeQueueEntries)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(mergeQueueEntries.id, id))
    .returning();
  return row ?? null;
}

/** Whether this branch is already in the queue and has not finished. */
export async function waitingFor(
  db: Db,
  projectId: string,
  branch: string,
): Promise<MergeQueueEntry | null> {
  const [row] = await db
    .select()
    .from(mergeQueueEntries)
    .where(
      and(
        eq(mergeQueueEntries.projectId, projectId),
        eq(mergeQueueEntries.branch, branch),
        inArray(mergeQueueEntries.state, ["waiting", "landing"]),
      ),
    )
    .orderBy(desc(mergeQueueEntries.position))
    .limit(1);
  return row ?? null;
}
