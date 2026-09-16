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

/** The ways a dashboard asks "what did we spend it on" (spec §7.1 `usage?group_by`; task 4.2). */
export const USAGE_GROUPS = ["model", "provider", "actor", "day", "key"] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

export type UsageSlice = {
  /** The model, the provider, the actor's id, the day, or the key — whichever was asked for. */
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

/**
 * The ledger, added up one way. One query per question: a dashboard asks three times and draws
 * three charts, rather than pulling every row into the api and grouping it there.
 */
export async function usageBy(
  db: Db,
  workspaceId: string,
  group: UsageGroup,
  window: { from?: Date; to?: Date } = {},
): Promise<UsageSlice[]> {
  const column =
    group === "model"
      ? sql`${usageEvents.modelId}`
      : group === "provider"
        ? sql`${usageEvents.provider}`
        : group === "actor"
          ? sql`coalesce(${usageEvents.actorId}::text, ${usageEvents.actorType})`
          : group === "key"
            ? sql`coalesce(${usageEvents.virtualKeyId}::text, '')`
            : sql`to_char(${usageEvents.ts}, 'YYYY-MM-DD')`;
  const where = [eq(usageEvents.workspaceId, workspaceId)];
  if (window.from) where.push(gte(usageEvents.ts, sql.param(window.from, usageEvents.ts)));
  if (window.to) where.push(sql`${usageEvents.ts} <= ${sql.param(window.to, usageEvents.ts)}`);
  const rows = await db
    .select({
      key: sql<string>`${column}`,
      calls: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
      costUsd: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)`,
    })
    .from(usageEvents)
    .where(and(...where))
    .groupBy(column)
    .orderBy(sql`coalesce(sum(${usageEvents.costUsd}), 0) desc`)
    .limit(200);
  return rows.map((row) => ({
    key: row.key ?? "",
    calls: Number(row.calls),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    costUsd: Number(row.costUsd),
  }));
}

/** What a workspace, a person or a bot has spent since a moment. */
export async function spentBy(
  db: Db,
  workspaceId: string,
  subject: { type: "workspace" | "user" | "bot"; id?: string | null },
  since: Date | null,
): Promise<number> {
  const where = [eq(usageEvents.workspaceId, workspaceId)];
  if (subject.type !== "workspace" && subject.id) {
    where.push(eq(usageEvents.actorId, subject.id));
  }
  if (since) where.push(gte(usageEvents.ts, sql.param(since, usageEvents.ts)));
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)` })
    .from(usageEvents)
    .where(and(...where));
  return Number(row?.total ?? 0);
}
