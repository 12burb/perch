/**
 * thread_facts (spec §6, §5.4 "shared state: the thread + thread_facts (structured scratchpad,
 * pinned)"; task 2.6). One row per key per thread: whoever writes last owns the value, and
 * everybody working the thread reads the same one.
 */
import type { Db, ThreadFactValue } from "@perch/db";
import { schema } from "@perch/db";
import { asc, eq, sql } from "drizzle-orm";

const { threadFacts } = schema;

export async function threadFactsOf(
  db: Db,
  threadRootId: string,
): Promise<Record<string, ThreadFactValue>> {
  const rows = await db
    .select()
    .from(threadFacts)
    .where(eq(threadFacts.threadRootId, threadRootId))
    .orderBy(asc(threadFacts.key));
  const out: Record<string, ThreadFactValue> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export async function upsertThreadFacts(
  db: Db,
  threadRootId: string,
  values: Record<string, ThreadFactValue>,
  by: { type: "user" | "bot"; id: string },
): Promise<void> {
  const rows = Object.entries(values).map(([key, value]) => ({
    threadRootId,
    key,
    value,
    updatedByType: by.type,
    updatedById: by.id,
  }));
  if (rows.length === 0) return;
  await db
    .insert(threadFacts)
    .values(rows)
    .onConflictDoUpdate({
      target: [threadFacts.threadRootId, threadFacts.key],
      set: {
        value: sqlExcluded("value"),
        updatedByType: sqlExcluded("updated_by_type"),
        updatedById: sqlExcluded("updated_by_id"),
        updatedAt: new Date(),
      },
    });
}

/** `excluded.<column>`: the row that lost the conflict is the one being written. */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
