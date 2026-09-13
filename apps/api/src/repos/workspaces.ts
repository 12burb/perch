import {
  type Db,
  type Membership,
  type MembershipRole,
  schema,
  type User,
  type Workspace,
  type WorkspaceSettings,
} from "@perch/db";
import { and, count, eq } from "drizzle-orm";

const { workspaces, memberships, users } = schema;

export async function insertWorkspace(
  db: Db,
  values: { slug: string; name: string },
): Promise<Workspace> {
  const [row] = await db.insert(workspaces).values(values).returning();
  if (!row) throw new Error("workspace insert returned no row");
  return row;
}

export async function findWorkspaceById(db: Db, id: string): Promise<Workspace | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return row ?? null;
}

export async function findWorkspaceBySlug(db: Db, slug: string): Promise<Workspace | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  return row ?? null;
}

export async function updateWorkspace(
  db: Db,
  id: string,
  patch: Partial<{ name: string; slug: string; settings: WorkspaceSettings }>,
): Promise<Workspace | null> {
  const [row] = await db.update(workspaces).set(patch).where(eq(workspaces.id, id)).returning();
  return row ?? null;
}

export async function insertMembership(
  db: Db,
  values: { workspaceId: string; userId: string; role: MembershipRole },
): Promise<Membership | null> {
  const [row] = await db.insert(memberships).values(values).onConflictDoNothing().returning();
  return row ?? null;
}

export async function findMembership(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<Membership | null> {
  const [row] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1);
  return row ?? null;
}

export type MemberRow = {
  membership: Membership;
  user: Pick<User, "id" | "name" | "handle" | "email" | "avatarFileId">;
};

/** Members with their profile, workspace-scoped (spec §9.1: scoping enforced in repositories). */
export async function listMembers(db: Db, workspaceId: string): Promise<MemberRow[]> {
  return db
    .select({
      membership: memberships,
      user: {
        id: users.id,
        name: users.name,
        handle: users.handle,
        email: users.email,
        avatarFileId: users.avatarFileId,
      },
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(memberships.createdAt);
}

export async function countOwners(db: Db, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "owner")));
  return row?.n ?? 0;
}

export async function updateMembershipRole(
  db: Db,
  workspaceId: string,
  userId: string,
  role: MembershipRole,
): Promise<Membership | null> {
  const [row] = await db
    .update(memberships)
    .set({ role })
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteMembership(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .delete(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .returning({ id: memberships.id });
  return rows.length > 0;
}

export async function listWorkspacesForUser(
  db: Db,
  userId: string,
): Promise<Array<{ workspace: Workspace; role: MembershipRole }>> {
  return db
    .select({ workspace: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(eq(memberships.userId, userId));
}
