/** races and race_entrants (spec §5.7; task 3.16). */
import type {
  Db,
  EntrantState,
  NewRace,
  NewRaceEntrant,
  Race,
  RaceEntrant,
  RaceState,
} from "@perch/db";
import { schema } from "@perch/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

const { races, raceEntrants } = schema;

export async function insertRace(db: Db, values: NewRace): Promise<Race> {
  const [row] = await db.insert(races).values(values).returning();
  if (!row) throw new Error("race insert returned no row");
  return row;
}

export async function insertEntrant(db: Db, values: NewRaceEntrant): Promise<RaceEntrant> {
  const [row] = await db.insert(raceEntrants).values(values).returning();
  if (!row) throw new Error("race entrant insert returned no row");
  return row;
}

export async function getRace(db: Db, id: string): Promise<Race | null> {
  const [row] = await db.select().from(races).where(eq(races.id, id)).limit(1);
  return row ?? null;
}

export async function getEntrant(db: Db, id: string): Promise<RaceEntrant | null> {
  const [row] = await db.select().from(raceEntrants).where(eq(raceEntrants.id, id)).limit(1);
  return row ?? null;
}

/** The entrants of a race, in the order they were entered. */
export function listEntrants(db: Db, raceId: string): Promise<RaceEntrant[]> {
  return db
    .select()
    .from(raceEntrants)
    .where(eq(raceEntrants.raceId, raceId))
    .orderBy(asc(raceEntrants.createdAt));
}

/** The entrant a session belongs to, which is how a race hears that one of them finished. */
export async function entrantForSession(db: Db, sessionId: string): Promise<RaceEntrant | null> {
  const [row] = await db
    .select()
    .from(raceEntrants)
    .where(eq(raceEntrants.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

export async function updateRace(
  db: Db,
  id: string,
  patch: Partial<Omit<NewRace, "id" | "workspaceId" | "projectId">>,
): Promise<Race | null> {
  const [row] = await db
    .update(races)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(races.id, id))
    .returning();
  return row ?? null;
}

export async function updateEntrant(
  db: Db,
  id: string,
  patch: Partial<Omit<NewRaceEntrant, "id" | "raceId">>,
): Promise<RaceEntrant | null> {
  const [row] = await db
    .update(raceEntrants)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(raceEntrants.id, id))
    .returning();
  return row ?? null;
}

/** Races on a project, newest first. */
export function listRaces(db: Db, projectId: string, states?: readonly RaceState[]) {
  const where = [eq(races.projectId, projectId)];
  if (states?.length) where.push(inArray(races.state, [...states]));
  return db
    .select()
    .from(races)
    .where(and(...where))
    .orderBy(desc(races.createdAt))
    .limit(50);
}

/** True while any entrant is still working. */
export async function anyRunning(db: Db, raceId: string): Promise<boolean> {
  const rows = await db
    .select({ state: raceEntrants.state })
    .from(raceEntrants)
    .where(eq(raceEntrants.raceId, raceId));
  return rows.some((row) => (row.state as EntrantState) === "running");
}
