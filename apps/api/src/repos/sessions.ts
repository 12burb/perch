/**
 * Sessions and their transcript (spec §6 coding_sessions, session_events; task 1.8, ADR-0074).
 * appendEvent hands out the next seq atomically (last_seq is bumped in the same transaction as the
 * insert), so a session's events are strictly monotonic whoever appends them.
 */
import {
  type CodingSession,
  type CodingSessionKind,
  type CodingSessionStatus,
  type Db,
  type SessionCheckpoint,
  type SessionEventRow,
  type SessionModeValue,
  type StoredSessionEvent,
  schema,
} from "@perch/db";
import type { ModelRef, SessionEvent } from "@perch/events";
import { and, asc, desc, eq, gt, ne, sql } from "drizzle-orm";

const { codingSessions, sessionCheckpoints, sessionEvents } = schema;

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
    forkedFromId?: string | null;
    kind?: CodingSessionKind;
    /** A fork starts with the turns of the transcript it copied, so turn numbers keep meaning. */
    turns?: number;
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
      forkedFromId: values.forkedFromId ?? null,
      ...(values.kind ? { kind: values.kind } : {}),
      ...(values.turns === undefined ? {} : { turns: values.turns }),
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
      and(
        eq(codingSessions.workspaceId, workspaceId),
        eq(codingSessions.projectId, projectId),
        // The editor's ⌘K lane is not a session anyone browses (task 1.14, ADR-0080).
        eq(codingSessions.kind, "agent"),
      ),
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

/** Copies a session's transcript into another (a fork, task 1.12); the target's seq follows. */
export async function copyEvents(
  db: Db,
  fromSessionId: string,
  toSessionId: string,
): Promise<number> {
  const rows = await db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, fromSessionId))
    .orderBy(asc(sessionEvents.seq));
  if (rows.length === 0) return 0;
  await db.transaction(async (tx) => {
    await tx
      .insert(sessionEvents)
      .values(
        rows.map((row) => ({ sessionId: toSessionId, seq: row.seq, event: row.event, ts: row.ts })),
      );
    const last = rows.at(-1)?.seq ?? 0;
    await tx
      .update(codingSessions)
      .set({ lastSeq: last })
      .where(eq(codingSessions.id, toSessionId));
  });
  return rows.length;
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

/** Records (or refreshes) the checkpoint taken before a turn (task 1.13). */
export async function upsertCheckpoint(
  db: Db,
  input: { sessionId: string; turn: number; gitRef: string },
): Promise<SessionCheckpoint> {
  const [row] = await db
    .insert(sessionCheckpoints)
    .values(input)
    .onConflictDoUpdate({
      target: [sessionCheckpoints.sessionId, sessionCheckpoints.turn],
      set: { gitRef: input.gitRef, createdAt: sql`now()` },
    })
    .returning();
  if (!row) throw new Error("insert session_checkpoints returned no row");
  return row;
}

export function listCheckpoints(db: Db, sessionId: string): Promise<SessionCheckpoint[]> {
  return db
    .select()
    .from(sessionCheckpoints)
    .where(eq(sessionCheckpoints.sessionId, sessionId))
    .orderBy(asc(sessionCheckpoints.turn));
}

export async function getCheckpoint(
  db: Db,
  sessionId: string,
  turn: number,
): Promise<SessionCheckpoint | null> {
  const [row] = await db
    .select()
    .from(sessionCheckpoints)
    .where(and(eq(sessionCheckpoints.sessionId, sessionId), eq(sessionCheckpoints.turn, turn)))
    .limit(1);
  return row ?? null;
}

/** Copies a session's checkpoints onto a fork: same turns, same commits in the same project. */
export async function copyCheckpoints(db: Db, from: string, to: string): Promise<number> {
  const rows = await listCheckpoints(db, from);
  if (rows.length === 0) return 0;
  await db
    .insert(sessionCheckpoints)
    .values(rows.map((row) => ({ sessionId: to, turn: row.turn, gitRef: row.gitRef })));
  return rows.length;
}

/** The editor's inline session for a person and project, reused across ⌘K edits (task 1.14). */
export async function findInlineSession(
  db: Db,
  projectId: string,
  userId: string,
): Promise<CodingSession | null> {
  const [row] = await db
    .select()
    .from(codingSessions)
    .where(
      and(
        eq(codingSessions.projectId, projectId),
        eq(codingSessions.userId, userId),
        eq(codingSessions.kind, "inline"),
        ne(codingSessions.status, "ended"),
      ),
    )
    .orderBy(desc(codingSessions.startedAt))
    .limit(1);
  return row ?? null;
}
