import { type Db, schema, type User } from "@perch/db";
import { and, eq } from "drizzle-orm";

const { users, authUser, memberships } = schema;

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

/**
 * Whether a person already has this handle.
 *
 * With a workspace, only the people in that workspace count. A handle is what somebody types after
 * an `@`, and a mention is resolved inside a workspace — so a Dawn in another one is not a clash,
 * and treating her as one stopped a workspace from having a bot called `@dawn` at all (task 3.24).
 * Without a workspace the question is instance-wide, which is what choosing a person's own handle
 * asks: a person is one person across every workspace they are in.
 */
export async function handleTaken(db: Db, handle: string, workspaceId?: string): Promise<boolean> {
  if (!workspaceId) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, handle))
      .limit(1);
    return row !== undefined;
  }
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(and(eq(users.handle, handle), eq(memberships.workspaceId, workspaceId)))
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
