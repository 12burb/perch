import { type Db, type Invite, type MembershipRole, schema } from "@perch/db";
import { eq } from "drizzle-orm";

const { invites } = schema;

export async function insertInvite(
  db: Db,
  values: {
    workspaceId: string;
    email: string;
    role: MembershipRole;
    tokenHash: string;
    expiresAt: Date;
  },
): Promise<Invite> {
  const [row] = await db.insert(invites).values(values).returning();
  if (!row) throw new Error("invite insert returned no row");
  return row;
}

export async function findInviteByHash(db: Db, tokenHash: string): Promise<Invite | null> {
  const [row] = await db.select().from(invites).where(eq(invites.tokenHash, tokenHash)).limit(1);
  return row ?? null;
}

export async function markInviteAccepted(db: Db, id: string, at: Date): Promise<void> {
  await db.update(invites).set({ acceptedAt: at }).where(eq(invites.id, id));
}
