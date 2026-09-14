/**
 * Sessions and their transcript (spec §6 coding_sessions, session_events; task 1.8, ADR-0074).
 * appendEvent hands out the next seq atomically (last_seq is bumped in the same transaction as the
 * insert), so a session's events are strictly monotonic whoever appends them.
 */
import {
  type CodingSession,
  type CodingSessionStatus,
  type Db,
  type SessionEventRow,
  type SessionModeValue,
  type StoredSessionEvent,
  schema,
} from "@perch/db";
import type { ModelRef, SessionEvent } from "@perch/events";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";

const { codingSessions, sessionEvents } = schema;

export async function insertSession(
  db: Db,
  values: {
    workspaceId: string;
    projectId: string;
    runnerId: string | null;
    userId: string;
    engine: string;
    model: ModelRef;
    mode: SessionModeValue;
    title: string | null;
  },
): Promise<CodingSession> {
  const [row] = await db
    .insert(codingSessions)
    .values({
      workspaceId: values.workspaceId,
      projectId: values.projectId,
      runnerId: values.runnerId,
      userId: values.userId,
      engine: values.engine,
      modelProvider: values.model.provider,
      modelId: values.model.modelId,
      modelProfileId: values.model.profileId ?? null,
      mode: values.mode,
      title: values.title,
    })
    .returning();
  if (!row) throw new Error("insert coding_sessions returned no row");
  return row;
}

export async function getSession(db: Db, id: string): Promise<CodingSession | null> {
  const [row] = await db.select().from(codingSessions).where(eq(codingSessions.id, id)).limit(1);
  return row ?? null;
}

/** A project's sessions, newest first. */
export function listSessions(
  db: Db,
  workspaceId: string,
  projectId: string,
  limit = 100,
): Promise<CodingSession[]> {
  return db
    .select()
    .from(codingSessions)
    .where(
      and(eq(codingSessions.workspaceId, workspaceId), eq(codingSessions.projectId, projectId)),
    )
    .orderBy(desc(codingSessions.startedAt), desc(codingSessions.id))
    .limit(limit);
}

export type SessionPatch = Partial<{
  status: CodingSessionStatus;
  statusMessage: string | null;
  engineSessionId: string | null;
  runnerId: string | null;
  title: string | null;
  turns: number;
  endedAt: Date | null;
}>;

export async function updateSession(
  db: Db,
  id: string,
  patch: SessionPatch,
): Promise<CodingSession | null> {
  const [row] = await db
    .update(codingSessions)
    .set(patch)
    .where(eq(codingSessions.id, id))
    .returning();
  return row ?? null;
}

/** Adds a round's cost to the session's total. */
export async function addCost(db: Db, id: string, costUsd: number): Promise<void> {
  await db
    .update(codingSessions)
    .set({
      costUsd: sql`${codingSessions.costUsd} + ${sql.param(costUsd, codingSessions.costUsd)}`,
    })
    .where(eq(codingSessions.id, id));
}

/** Appends an event at the next seq of the session. */
export async function appendEvent(
  db: Db,
  sessionId: string,
  event: SessionEvent,
): Promise<{ seq: number; ts: Date }> {
  return db.transaction(async (tx) => {
    const [bumped] = await tx
      .update(codingSessions)
      .set({ lastSeq: sql`${codingSessions.lastSeq} + 1` })
      .where(eq(codingSessions.id, sessionId))
      .returning({ seq: codingSessions.lastSeq });
    if (!bumped) throw new Error(`session ${sessionId} not found`);
    const [row] = await tx
      .insert(sessionEvents)
      .values({ sessionId, seq: bumped.seq, event: event as StoredSessionEvent })
      .returning({ ts: sessionEvents.ts });
    if (!row) throw new Error("insert session_events returned no row");
    return { seq: bumped.seq, ts: row.ts };
  });
}

/** Events after `afterSeq`, in order, at most `limit` of them. */
export function listEvents(
  db: Db,
  sessionId: string,
  afterSeq = 0,
  limit = 500,
): Promise<SessionEventRow[]> {
  return db
    .select()
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.seq, afterSeq)))
    .orderBy(asc(sessionEvents.seq))
    .limit(limit);
}
