/**
 * Where the policy documents are kept (spec §5.7; task 2.11): one on the workspace, one on each
 * project, both as the YAML they were written in so what comes back is what somebody typed.
 */
import type { Db } from "@perch/db";
import { schema } from "@perch/db";
import { eq } from "drizzle-orm";

const { projects, workspaces } = schema;

export async function workspacePolicyYaml(db: Db, workspaceId: string): Promise<string> {
  const [row] = await db
    .select({ yaml: workspaces.policyYaml })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.yaml ?? "";
}

export async function setWorkspacePolicyYaml(
  db: Db,
  workspaceId: string,
  yaml: string,
): Promise<void> {
  await db
    .update(workspaces)
    .set({ policyYaml: yaml.trim() ? yaml : null, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
}

export async function setProjectPolicyYaml(db: Db, projectId: string, yaml: string): Promise<void> {
  await db
    .update(projects)
    .set({ policyYaml: yaml.trim() ? yaml : null, updatedAt: new Date() })
    .where(eq(projects.id, projectId));
}
