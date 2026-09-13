import { type Db, type Membership, type MembershipRole, schema, type Workspace } from "@perch/db";
import { and, eq } from "drizzle-orm";

const { workspaces, memberships } = schema;

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

export async function listWorkspacesForUser(
  db: Db,
  userId: string,
): Promise<Array<{ workspace: Workspace; role: MembershipRole }>> {
  const rows = await db
    .select({ workspace: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(eq(memberships.userId, userId));
  return rows;
}
