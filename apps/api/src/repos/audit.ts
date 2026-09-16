import { type AuditActorType, type AuditRow, type Db, type NewAuditRow, schema } from "@perch/db";
import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";

const { auditLog } = schema;

export async function insertAudit(db: Db, row: NewAuditRow): Promise<AuditRow> {
  const [inserted] = await db.insert(auditLog).values(row).returning();
  if (!inserted) throw new Error("audit insert returned no row");
  return inserted;
}

/** What the audit page can narrow by (task 4.5). Every field is optional and they all AND. */
export type AuditFilter = {
  /** Keyset cursor: rows strictly older than this timestamp. */
  before?: Date;
  limit: number;
  action?: string;
  actorType?: AuditActorType;
  actorId?: string;
  targetType?: string;
  from?: Date;
  to?: Date;
};

function conditions(workspaceId: string | undefined, filter: AuditFilter) {
  const where = workspaceId ? [eq(auditLog.workspaceId, workspaceId)] : [];
  if (filter.before) where.push(lt(auditLog.ts, filter.before));
  if (filter.action) where.push(eq(auditLog.action, filter.action));
  if (filter.actorType) where.push(eq(auditLog.actorType, filter.actorType));
  if (filter.actorId) where.push(eq(auditLog.actorId, filter.actorId));
  if (filter.targetType) where.push(eq(auditLog.targetType, filter.targetType));
  if (filter.from) where.push(gte(auditLog.ts, filter.from));
  if (filter.to) where.push(lte(auditLog.ts, filter.to));
  return where;
}

export async function listAudit(
  db: Db,
  workspaceId: string,
  filter: AuditFilter,
): Promise<AuditRow[]> {
  return db
    .select()
    .from(auditLog)
    .where(and(...conditions(workspaceId, filter)))
    .orderBy(desc(auditLog.ts), desc(auditLog.id))
    .limit(filter.limit);
}

/** The same query across every workspace, for the instance's own audit page (spec §7.1). */
export async function listAuditEverywhere(db: Db, filter: AuditFilter): Promise<AuditRow[]> {
  return db
    .select()
    .from(auditLog)
    .where(and(...conditions(undefined, filter)))
    .orderBy(desc(auditLog.ts), desc(auditLog.id))
    .limit(filter.limit);
}

/** The actions this workspace has actually recorded, so a filter can offer real choices. */
export async function auditActions(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.workspaceId, workspaceId))
    .orderBy(auditLog.action)
    .limit(200);
  return rows.map((row) => row.action);
}

/**
 * Retention (task 4.5): everything older than `before` goes. Returns how many rows went.
 *
 * In batches, because a year of an instance's audit log is not a row count anybody should hold in
 * one transaction — and a prune that times out deletes nothing at all.
 */
export async function pruneAudit(db: Db, before: Date, batch = 5_000): Promise<number> {
  let removed = 0;
  for (;;) {
    const older = db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(lt(auditLog.ts, sql.param(before, auditLog.ts)))
      .limit(batch);
    const deleted = await db
      .delete(auditLog)
      .where(inArray(auditLog.id, older))
      .returning({ id: auditLog.id });
    removed += deleted.length;
    if (deleted.length < batch) return removed;
  }
}
