/**
 * virtual_keys and usage_events (spec §6; task 4.1). A key is how something outside Perch reaches
 * `/v1`; a usage event is what one call cost, whoever made it.
 */
import type { Db, KeyBudget, KeySubject, UsageActor, UsageEvent, VirtualKey } from "@perch/db";
import { schema } from "@perch/db";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

const { virtualKeys, usageEvents } = schema;

export async function insertVirtualKey(
  db: Db,
  input: {
    workspaceId: string;
    subjectType: KeySubject;
    subjectId?: string | null;
    name: string;
    keyHash: string;
    prefix: string;
    budget: KeyBudget;
    models: string[];
    expiresAt?: Date | null;
    createdBy: string;
  },
): Promise<VirtualKey> {
  const [row] = await db
    .insert(virtualKeys)
    .values({
      workspaceId: input.workspaceId,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      name: input.name,
      keyHash: input.keyHash,
      prefix: input.prefix,
      budget: input.budget,
      models: input.models,
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  if (!row) throw new Error("the virtual key was not written");
  return row;
}

export async function findVirtualKeyByHash(db: Db, hash: string): Promise<VirtualKey | null> {
  const [row] = await db.select().from(virtualKeys).where(eq(virtualKeys.keyHash, hash)).limit(1);
  return row ?? null;
}

export async function getVirtualKey(db: Db, id: string): Promise<VirtualKey | null> {
  const [row] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, id)).limit(1);
  return row ?? null;
}

/** A workspace's keys, newest first. Revoked ones stay: what spent money is worth keeping. */
export async function listVirtualKeys(db: Db, workspaceId: string): Promise<VirtualKey[]> {
  return db
    .select()
    .from(virtualKeys)
    .where(eq(virtualKeys.workspaceId, workspaceId))
    .orderBy(desc(virtualKeys.createdAt))
    .limit(500);
}

export async function revokeVirtualKey(db: Db, id: string, at: Date): Promise<VirtualKey | null> {
  const [row] = await db
    .update(virtualKeys)
    .set({ revokedAt: at, updatedAt: at })
    .where(and(eq(virtualKeys.id, id), isNull(virtualKeys.revokedAt)))
    .returning();
  return row ?? null;
}

/** Last used, written at most once a minute: a ledger already says what every call did. */
export async function touchVirtualKey(db: Db, id: string, at: Date): Promise<void> {
  await db.update(virtualKeys).set({ lastUsedAt: at }).where(eq(virtualKeys.id, id));
}

export async function insertUsageEvent(
  db: Db,
  input: {
    workspaceId: string;
    actorType: UsageActor;
    actorId?: string | null;
    sessionId?: string | null;
    botRunId?: string | null;
    virtualKeyId?: string | null;
    provider: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    costUsd: number;
  },
): Promise<UsageEvent> {
  const [row] = await db
    .insert(usageEvents)
    .values({
      workspaceId: input.workspaceId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      sessionId: input.sessionId ?? null,
      botRunId: input.botRunId ?? null,
      virtualKeyId: input.virtualKeyId ?? null,
      provider: input.provider,
      modelId: input.modelId,
      inputTokens: Math.max(0, Math.round(input.inputTokens)),
      outputTokens: Math.max(0, Math.round(input.outputTokens)),
      cachedTokens: Math.max(0, Math.round(input.cachedTokens ?? 0)),
      // The column is numeric(12,6); a string keeps it exact all the way down.
      costUsd: input.costUsd.toFixed(6),
    })
    .returning();
  if (!row) throw new Error("the usage event was not written");
  return row;
}

/** What one key has spent since a moment, in dollars. */
export async function spentByKey(db: Db, keyId: string, since: Date | null): Promise<number> {
  const where = since
    ? and(
        eq(usageEvents.virtualKeyId, keyId),
        gte(usageEvents.ts, sql.param(since, usageEvents.ts)),
      )
    : eq(usageEvents.virtualKeyId, keyId);
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)` })
    .from(usageEvents)
    .where(where);
  return Number(row?.total ?? 0);
}

/** Every call in a workspace since a moment, newest first — what a dashboard reads. */
export async function listUsage(
  db: Db,
  workspaceId: string,
  options: { from?: Date; to?: Date; limit?: number } = {},
): Promise<UsageEvent[]> {
  const where = [eq(usageEvents.workspaceId, workspaceId)];
  if (options.from) where.push(gte(usageEvents.ts, sql.param(options.from, usageEvents.ts)));
  if (options.to) {
    where.push(sql`${usageEvents.ts} <= ${sql.param(options.to, usageEvents.ts)}`);
  }
  return db
    .select()
    .from(usageEvents)
    .where(and(...where))
    .orderBy(desc(usageEvents.ts))
    .limit(Math.min(options.limit ?? 500, 5_000));
}
