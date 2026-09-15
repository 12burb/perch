/**
 * project_env (spec §6; task 2.13): one row per key per project, the value sealed by the vault so
 * a database dump is not a list of everybody's credentials.
 */
import type { Db, ProjectEnvRow, ProjectEnvSource } from "@perch/db";
import { schema } from "@perch/db";
import { and, asc, eq, inArray } from "drizzle-orm";

const { projectEnv } = schema;

export function listEnvRows(db: Db, projectId: string): Promise<ProjectEnvRow[]> {
  return db
    .select()
    .from(projectEnv)
    .where(eq(projectEnv.projectId, projectId))
    .orderBy(asc(projectEnv.key));
}

export async function upsertEnvRow(
  db: Db,
  values: {
    projectId: string;
    key: string;
    ciphertext: Uint8Array;
    source?: ProjectEnvSource | undefined;
  },
): Promise<ProjectEnvRow> {
  const [row] = await db
    .insert(projectEnv)
    .values({
      projectId: values.projectId,
      key: values.key,
      ciphertext: values.ciphertext,
      ...(values.source ? { source: values.source } : {}),
    })
    .onConflictDoUpdate({
      target: [projectEnv.projectId, projectEnv.key],
      set: {
        ciphertext: values.ciphertext,
        ...(values.source ? { source: values.source } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("project env insert returned no row");
  return row;
}

export async function deleteEnvRows(db: Db, projectId: string, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const gone = await db
    .delete(projectEnv)
    .where(and(eq(projectEnv.projectId, projectId), inArray(projectEnv.key, keys)))
    .returning({ id: projectEnv.id });
  return gone.length;
}
