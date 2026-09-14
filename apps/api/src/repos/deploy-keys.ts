import { type Db, type DeployKey, schema } from "@perch/db";
import { eq } from "drizzle-orm";

const { deployKeys } = schema;

export async function findDeployKey(db: Db, workspaceId: string): Promise<DeployKey | null> {
  const [row] = await db
    .select()
    .from(deployKeys)
    .where(eq(deployKeys.workspaceId, workspaceId))
    .limit(1);
  return row ?? null;
}

/** One key per workspace: inserting again replaces it (rotation). */
export async function upsertDeployKey(
  db: Db,
  values: {
    workspaceId: string;
    publicKey: string;
    fingerprint: string;
    privateKeyCiphertext: Uint8Array;
  },
): Promise<DeployKey> {
  const [row] = await db
    .insert(deployKeys)
    .values(values)
    .onConflictDoUpdate({
      target: deployKeys.workspaceId,
      set: {
        publicKey: values.publicKey,
        fingerprint: values.fingerprint,
        privateKeyCiphertext: values.privateKeyCiphertext,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("upsert deploy_keys returned no row");
  return row;
}
