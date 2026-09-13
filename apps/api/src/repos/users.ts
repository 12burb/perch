import { type Db, schema, type User } from "@perch/db";
import { eq } from "drizzle-orm";

const { users, authUser } = schema;

export async function findUserById(db: Db, id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function findUserByAuthUserId(db: Db, authUserId: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.authUserId, authUserId)).limit(1);
  return row ?? null;
}

export async function findUserByEmail(db: Db, email: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return row ?? null;
}

export async function handleTaken(db: Db, handle: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1);
  return row !== undefined;
}

export async function insertUser(
  db: Db,
  values: { authUserId: string; email: string; name: string; handle: string },
): Promise<User | null> {
  const [row] = await db.insert(users).values(values).onConflictDoNothing().returning();
  return row ?? null;
}

export async function updateUser(
  db: Db,
  id: string,
  patch: Partial<Pick<User, "name" | "handle" | "locale" | "tz" | "avatarFileId">>,
): Promise<User | null> {
  const [row] = await db.update(users).set(patch).where(eq(users.id, id)).returning();
  return row ?? null;
}

export async function emailVerified(db: Db, authUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ emailVerified: authUser.emailVerified })
    .from(authUser)
    .where(eq(authUser.id, authUserId))
    .limit(1);
  return row?.emailVerified ?? false;
}
