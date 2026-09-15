import {
  type Db,
  type Project,
  type ProjectConfig,
  type ProjectSource,
  type ProjectStatus,
  schema,
} from "@perch/db";
import { and, desc, eq } from "drizzle-orm";

const { projects } = schema;

export async function insertProject(
  db: Db,
  values: {
    workspaceId: string;
    key: string;
    name: string;
    source: ProjectSource;
    repoUrl?: string | null;
    defaultBranch?: string;
    createdBy?: string | null;
  },
): Promise<Project> {
  const [row] = await db
    .insert(projects)
    .values({
      workspaceId: values.workspaceId,
      key: values.key,
      name: values.name,
      source: values.source,
      status: "pending",
      repoUrl: values.repoUrl ?? null,
      ...(values.defaultBranch ? { defaultBranch: values.defaultBranch } : {}),
      createdBy: values.createdBy ?? null,
    })
    .returning();
  if (!row) throw new Error("insert projects returned no row");
  return row;
}

/** Workspace-scoped: a project id from another workspace is not found. */
export async function findProject(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<Project | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
    .limit(1);
  return row ?? null;
}

export async function findProjectByKey(
  db: Db,
  workspaceId: string,
  key: string,
): Promise<Project | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.key, key)))
    .limit(1);
  return row ?? null;
}

export async function listProjects(db: Db, workspaceId: string): Promise<Project[]> {
  return db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
    .orderBy(desc(projects.createdAt));
}

export type ProjectPatch = Partial<{
  name: string;
  repoUrl: string | null;
  status: ProjectStatus;
  statusMessage: string | null;
  runnerId: string | null;
  head: string | null;
  defaultBranch: string;
  defaultEngine: string;
  config: ProjectConfig;
  configError: string | null;
  devcontainer: Record<string, unknown> | null;
}>;

export async function updateProject(db: Db, id: string, patch: ProjectPatch): Promise<Project> {
  const [row] = await db
    .update(projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning();
  if (!row) throw new Error("update projects returned no row");
  return row;
}

export async function deleteProject(db: Db, workspaceId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
    .returning({ id: projects.id });
  return rows.length > 0;
}
