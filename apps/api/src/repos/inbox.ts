/**
 * inbox_items (spec §6; task 2.10). One row is one thing waiting for one person; the unique index
 * on (user, kind, ref) is what makes an event arriving twice one item rather than two.
 */
import type { Db, InboxItem, InboxKind, InboxStatus, NewInboxItem } from "@perch/db";
import { schema } from "@perch/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

const { inboxItems } = schema;

/**
 * Puts an item in somebody's inbox, or leaves the one already there alone. An item that was
 * resolved and happens again is open again: the thing needs a person once more.
 */
export async function addItem(db: Db, values: NewInboxItem): Promise<InboxItem> {
  const [row] = await db
    .insert(inboxItems)
    .values(values)
    .onConflictDoUpdate({
      target: [inboxItems.userId, inboxItems.kind, inboxItems.refType, inboxItems.refId],
      set: {
        status: "open",
        payload: values.payload ?? {},
        snoozedUntil: null,
        resolvedAt: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("inbox item insert returned no row");
  return row;
}

export async function getItem(db: Db, id: string): Promise<InboxItem | null> {
  const [row] = await db.select().from(inboxItems).where(eq(inboxItems.id, id)).limit(1);
  return row ?? null;
}

export type ListOptions = {
  status?: InboxStatus | "all" | undefined;
  kinds?: readonly InboxKind[] | undefined;
  limit?: number | undefined;
  now?: Date | undefined;
};

/**
 * Somebody's queue, newest first. A snooze that has run out is open again — the moment it comes
 * back is the moment it is asked for, so nothing has to sweep the table.
 */
export async function listItems(
  db: Db,
  userId: string,
  options: ListOptions = {},
): Promise<InboxItem[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const now = options.now ?? new Date();
  const where = [eq(inboxItems.userId, userId)];
  // A moment is bound through the column's own encoder, never dropped into the template (ADR-0061).
  const moment = sql.param(now, inboxItems.snoozedUntil);
  const awake = sql`(${inboxItems.status} = 'open' or (${inboxItems.status} = 'snoozed' and ${inboxItems.snoozedUntil} is not null and ${inboxItems.snoozedUntil} <= ${moment}))`;
  const asleep = sql`(${inboxItems.status} = 'snoozed' and (${inboxItems.snoozedUntil} is null or ${inboxItems.snoozedUntil} > ${moment}))`;
  const status = options.status ?? "open";
  if (status === "open") where.push(awake);
  else if (status === "snoozed") where.push(asleep);
  else if (status !== "all") where.push(eq(inboxItems.status, status));
  if (options.kinds && options.kinds.length > 0) {
    where.push(inArray(inboxItems.kind, [...options.kinds]));
  }
  return db
    .select()
    .from(inboxItems)
    .where(and(...where))
    .orderBy(desc(inboxItems.createdAt))
    .limit(limit);
}

export async function setStatus(
  db: Db,
  id: string,
  values: { status: InboxStatus; snoozedUntil?: Date | null; resolvedAt?: Date | null },
): Promise<InboxItem | null> {
  const [row] = await db
    .update(inboxItems)
    .set({
      status: values.status,
      ...(values.snoozedUntil === undefined ? {} : { snoozedUntil: values.snoozedUntil }),
      ...(values.resolvedAt === undefined ? {} : { resolvedAt: values.resolvedAt }),
      updatedAt: new Date(),
    })
    .where(eq(inboxItems.id, id))
    .returning();
  return row ?? null;
}

/** Resolves whatever item points at this thing, if one is still open (an answer, a fix, a read). */
export async function resolveRef(
  db: Db,
  input: { kind: InboxKind; refType: string; refId: string; userId?: string | undefined },
): Promise<InboxItem[]> {
  const where = [
    eq(inboxItems.kind, input.kind),
    eq(inboxItems.refType, input.refType),
    eq(inboxItems.refId, input.refId),
  ];
  if (input.userId) where.push(eq(inboxItems.userId, input.userId));
  return db
    .update(inboxItems)
    .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
    .where(and(...where, eq(inboxItems.status, "open")))
    .returning();
}
