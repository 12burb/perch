/**
 * Where the policy documents are kept (spec §6 `policies`, §5.7; task 2.11): one row per
 * workspace, and one per project that has its own. The row holds what the document parsed to —
 * `rules` — and the YAML it was written in, so what comes back is what somebody typed.
 */
import type { Db, Policy as PolicyRow, PolicyRules } from "@perch/db";
import { schema } from "@perch/db";
import { and, eq, isNull, sql } from "drizzle-orm";

const { policies } = schema;

export type PolicyKey = { workspaceId: string; projectId?: string | null | undefined };

function where(key: PolicyKey) {
  return key.projectId
    ? and(eq(policies.workspaceId, key.workspaceId), eq(policies.projectId, key.projectId))
    : and(eq(policies.workspaceId, key.workspaceId), isNull(policies.projectId));
}

export async function findPolicy(db: Db, key: PolicyKey): Promise<PolicyRow | null> {
  const [row] = await db.select().from(policies).where(where(key)).limit(1);
  return row ?? null;
}

/**
 * Writes the document, keeping its history in the one place §6 gives it: `version` counts up and
 * `updated_by` says who. An empty document is the row going away, not a row saying nothing.
 *
 * One statement, not a read and then a write: two saves at once (a double submit, two admins) meet
 * at the unique index on the key and the later one updates the earlier one's row, so there is
 * never a second document for enforcement to pick between, and the version counts both (ADR-0175).
 */
export async function savePolicy(
  db: Db,
  key: PolicyKey,
  input: { yaml: string; rules: PolicyRules; userId: string },
): Promise<PolicyRow | null> {
  if (!input.yaml.trim()) {
    await db.delete(policies).where(where(key));
    return null;
  }
  const [row] = await db
    .insert(policies)
    .values({
      workspaceId: key.workspaceId,
      projectId: key.projectId ?? null,
      yaml: input.yaml,
      rules: input.rules,
      updatedBy: input.userId,
    })
    .onConflictDoUpdate({
      // The partial unique index that owns this key: one per workspace, or one per project.
      target: key.projectId ? [policies.workspaceId, policies.projectId] : [policies.workspaceId],
      targetWhere: key.projectId
        ? sql`${policies.projectId} is not null`
        : sql`${policies.projectId} is null`,
      set: {
        yaml: input.yaml,
        rules: input.rules,
        version: sql`${policies.version} + 1`,
        updatedBy: input.userId,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row ?? null;
}
