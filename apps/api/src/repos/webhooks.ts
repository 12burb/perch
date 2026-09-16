/**
 * webhooks and webhook_deliveries (spec §3.5; task 3.4). The delivery table is the replay guard:
 * the unique index is what makes "the same delivery twice" one card rather than two.
 */
import { type Db, type NewWebhook, schema, type Webhook } from "@perch/db";
import { and, desc, eq, lt, sql } from "drizzle-orm";

const { webhooks, webhookDeliveries } = schema;

export async function insertWebhook(db: Db, values: NewWebhook): Promise<Webhook> {
  const [row] = await db.insert(webhooks).values(values).returning();
  if (!row) throw new Error("insert webhooks returned no row");
  return row;
}

export function listWebhooks(db: Db, workspaceId: string): Promise<Webhook[]> {
  return db
    .select()
    .from(webhooks)
    .where(eq(webhooks.workspaceId, workspaceId))
    .orderBy(desc(webhooks.createdAt));
}

export async function getWebhook(db: Db, id: string): Promise<Webhook | null> {
  const [row] = await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
  return row ?? null;
}

export async function deleteWebhook(db: Db, workspaceId: string, id: string): Promise<boolean> {
  const [row] = await db
    .delete(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.workspaceId, workspaceId)))
    .returning({ id: webhooks.id });
  return row !== undefined;
}

/** Counts one delivery against the endpoint, so a list says when it was last used. */
export async function touchWebhook(db: Db, id: string): Promise<void> {
  await db
    .update(webhooks)
    .set({ lastDeliveryAt: new Date(), deliveries: sql`${webhooks.deliveries} + 1` })
    .where(eq(webhooks.id, id));
}

/**
 * Records a delivery, and says whether it is the first time. A provider that never heard the 200
 * sends again; the second one is not news.
 */
export async function firstTime(
  db: Db,
  input: { webhookId: string; deliveryId: string; event: string | null },
): Promise<boolean> {
  const rows = await db
    .insert(webhookDeliveries)
    .values({
      webhookId: input.webhookId,
      deliveryId: input.deliveryId,
      event: input.event,
    })
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.id });
  return rows.length > 0;
}

/** Deliveries older than this are not worth remembering; a provider gives up long before. */
export async function forgetOldDeliveries(db: Db, before: Date): Promise<number> {
  const rows = await db
    .delete(webhookDeliveries)
    .where(lt(webhookDeliveries.receivedAt, before))
    .returning({ id: webhookDeliveries.id });
  return rows.length;
}
