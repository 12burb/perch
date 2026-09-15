/**
 * preview_shares (spec §6; task 1.18). A share is a hash and an expiry, never the token itself.
 */
import { type Db, type PreviewShare, schema } from "@perch/db";
import { and, desc, eq, isNull } from "drizzle-orm";

const { previewShares } = schema;

export async function insertShare(
  db: Db,
  values: {
    workspaceId: string;
    projectId: string;
    runnerId: string | null;
    port: number;
    path: string;
    tokenHash: string;
    public: boolean;
    expiresAt: Date;
    createdBy: string;
  },
): Promise<PreviewShare> {
  const [row] = await db.insert(previewShares).values(values).returning();
  if (!row) throw new Error("preview share insert returned no row");
  return row;
}

/** The share a token opens, whatever its state: the caller decides with `shareAllows`. */
export async function findShareByHash(db: Db, tokenHash: string): Promise<PreviewShare | null> {
  const [row] = await db
    .select()
    .from(previewShares)
    .where(eq(previewShares.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export async function getShare(db: Db, id: string): Promise<PreviewShare | null> {
  const [row] = await db.select().from(previewShares).where(eq(previewShares.id, id)).limit(1);
  return row ?? null;
}

/** Live shares for a project, newest first. A revoked share is gone from the card. */
export async function listSharesForProject(
  db: Db,
  workspaceId: string,
  projectId: string,
): Promise<PreviewShare[]> {
  return db
    .select()
    .from(previewShares)
    .where(
      and(
        eq(previewShares.workspaceId, workspaceId),
        eq(previewShares.projectId, projectId),
        isNull(previewShares.revokedAt),
      ),
    )
    .orderBy(desc(previewShares.createdAt));
}

export async function revokeShare(db: Db, id: string): Promise<PreviewShare | null> {
  const [row] = await db
    .update(previewShares)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(previewShares.id, id), isNull(previewShares.revokedAt)))
    .returning();
  return row ?? null;
}
