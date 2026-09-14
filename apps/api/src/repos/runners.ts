import { type Db, type Runner, type RunnerCapabilities, type RunnerToken, schema } from "@perch/db";
import { and, eq, sql } from "drizzle-orm";

const { runners, runnerTokens } = schema;

export async function insertRunner(
  db: Db,
  values: {
    /** Null: a runner every workspace may use (the shared hosted runner). */
    workspaceId: string | null;
    kind: Runner["kind"];
    name: string;
    ownerUserId?: string | null;
    capabilities?: RunnerCapabilities;
  },
): Promise<Runner> {
  const [row] = await db
    .insert(runners)
    .values({
      workspaceId: values.workspaceId,
      kind: values.kind,
      name: values.name,
      ownerUserId: values.ownerUserId ?? null,
      capabilities: values.capabilities ?? {},
    })
    .returning();
  if (!row) throw new Error("insert runners returned no row");
  return row;
}

export async function findRunnerById(db: Db, id: string): Promise<Runner | null> {
  const [row] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
  return row ?? null;
}

export async function listRunners(db: Db, workspaceId: string): Promise<Runner[]> {
  return db.select().from(runners).where(eq(runners.workspaceId, workspaceId));
}

export async function updateRunner(
  db: Db,
  id: string,
  patch: {
    status?: string;
    name?: string;
    capabilities?: RunnerCapabilities;
    lastSeenAt?: Date;
    idleSince?: Date | null;
    containerId?: string | null;
  },
): Promise<void> {
  await db
    .update(runners)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(runners.id, id));
}

/** A heartbeat: the runner is idle from now on when it carries no sessions, busy otherwise. */
export async function recordHeartbeat(
  db: Db,
  id: string,
  sessions: number,
  at: Date,
): Promise<void> {
  await db
    .update(runners)
    .set({
      lastSeenAt: at,
      idleSince:
        sessions > 0
          ? null
          : sql`coalesce(${runners.idleSince}, ${sql.param(at, runners.idleSince)})`,
      updatedAt: at,
    })
    .where(eq(runners.id, id));
}

export async function insertRunnerToken(
  db: Db,
  values: { runnerId: string; tokenHash: string; expiresAt: Date },
): Promise<RunnerToken> {
  const [row] = await db.insert(runnerTokens).values(values).returning();
  if (!row) throw new Error("insert runner_tokens returned no row");
  return row;
}

/** The token row and its runner; null when the hash is unknown. */
export async function findRunnerTokenByHash(
  db: Db,
  tokenHash: string,
): Promise<{ token: RunnerToken; runner: Runner } | null> {
  const [row] = await db
    .select({ token: runnerTokens, runner: runners })
    .from(runnerTokens)
    .innerJoin(runners, eq(runnerTokens.runnerId, runners.id))
    .where(eq(runnerTokens.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export async function revokeRunnerToken(db: Db, runnerId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(runnerTokens)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(runnerTokens.id, id), eq(runnerTokens.runnerId, runnerId)))
    .returning({ id: runnerTokens.id });
  return rows.length > 0;
}
