import { type AuditRow, type Db, type NewAuditRow, schema } from "@perch/db";
import { and, desc, eq, lt } from "drizzle-orm";

const { auditLog } = schema;

export async function insertAudit(db: Db, row: NewAuditRow): Promise<AuditRow> {
  const [inserted] = await db.insert(auditLog).values(row).returning();
  if (!inserted) throw new Error("audit insert returned no row");
  return inserted;
}

export async function listAudit(
  db: Db,
  workspaceId: string,
  options: { before?: Date; limit: number; action?: string },
): Promise<AuditRow[]> {
  const where = [eq(auditLog.workspaceId, workspaceId)];
  if (options.before) where.push(lt(auditLog.ts, options.before));
  if (options.action) where.push(eq(auditLog.action, options.action));
  return db
    .select()
    .from(auditLog)
    .where(and(...where))
    .orderBy(desc(auditLog.ts), desc(auditLog.id))
    .limit(options.limit);
}
