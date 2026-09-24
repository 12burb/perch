import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import {
  createDb,
  type DbHandle,
  embeddedMigrations,
  migrateTo,
  newId,
  schema,
} from "../src/index.ts";

/**
 * One policy document per workspace and one per project (ADR-0175). Migration 0040 removes the
 * duplicates a concurrent first save could leave behind, keeping the newest, and then makes a
 * second one impossible.
 */

const BEFORE_UNIQUE = embeddedMigrations().findIndex((m) =>
  m.sql.some((statement) => statement.includes('"policies_workspace_idx"')),
);

let handle: DbHandle;
const workspaceId = newId();
const projectId = newId();
const userId = newId();

beforeAll(async () => {
  handle = await createDb({ url: "pglite://memory" });
  expect(BEFORE_UNIQUE).toBeGreaterThan(0);
  await migrateTo(handle.db, BEFORE_UNIQUE);
  await handle.db
    .insert(schema.authUser)
    .values({ id: "auth-robin", name: "Robin", email: "robin@perch.test" });
  await handle.db.insert(schema.users).values({
    id: userId,
    authUserId: "auth-robin",
    email: "robin@perch.test",
    handle: "robin",
    name: "Robin",
  });
  await handle.db.insert(schema.workspaces).values({ id: workspaceId, name: "Nest", slug: "nest" });
  await handle.db
    .insert(schema.projects)
    .values({ id: projectId, workspaceId, key: "APP", name: "app" });
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

describe("policies are unique per workspace and per project", () => {
  test("the migration keeps the newest duplicate, and a second document is refused after it", async () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 10, minute));
    const policy = (yaml: string, minute: number, project: string | null) => ({
      workspaceId,
      projectId: project,
      yaml,
      rules: {},
      updatedBy: userId,
      updatedAt: at(minute),
    });
    // What a double-submitted first save left behind, for the workspace and for a project.
    await handle.db
      .insert(schema.policies)
      .values([
        policy("first", 1, null),
        policy("second", 2, null),
        policy("project-old", 1, projectId),
        policy("project-new", 3, projectId),
      ]);

    await handle.migrate();

    const rows = await handle.db
      .select({ yaml: schema.policies.yaml, projectId: schema.policies.projectId })
      .from(schema.policies)
      .where(eq(schema.policies.workspaceId, workspaceId))
      .orderBy(asc(schema.policies.yaml));
    expect(rows).toEqual([
      { yaml: "project-new", projectId },
      { yaml: "second", projectId: null },
    ]);

    await expect(
      (async () => handle.db.insert(schema.policies).values(policy("third", 4, null)))(),
    ).rejects.toThrow();
    await expect(
      (async () => handle.db.insert(schema.policies).values(policy("again", 4, projectId)))(),
    ).rejects.toThrow();
  }, 60_000);
});
