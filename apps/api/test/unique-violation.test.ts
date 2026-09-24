import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Db, type DbHandle, schema } from "@perch/db";
import { createTestDb } from "@perch/db/testing";
import { isUniqueViolation } from "../src/errors.ts";
import { enqueue } from "../src/repos/merge.ts";
import { insertWorkItem } from "../src/repos/work.ts";

/**
 * X-data-03: the unique index is what keeps `KEY-123` numbers and queue positions unique when two
 * writers read the same `max()`, and the loser is meant to retry with the next number. drizzle wraps
 * the driver's error, so a check that reads the message never recognised the violation: the retry
 * never ran, and the second writer got a 500. These hold the check to the error drizzle really
 * throws, and the retry to a collision that really happened.
 */

let handle: DbHandle;
let db: Db;
let workspaceId = "";
let projectId = "";

beforeAll(async () => {
  handle = await createTestDb();
  db = handle.db;
  const [ws] = await db
    .insert(schema.workspaces)
    .values({ slug: `uv-${Date.now()}`, name: "Unique" })
    .returning();
  if (!ws) throw new Error("no workspace");
  workspaceId = ws.id;
  const [project] = await db
    .insert(schema.projects)
    .values({ workspaceId, key: "UV", name: "unique" })
    .returning();
  if (!project) throw new Error("no project");
  projectId = project.id;
}, 60_000);

afterAll(async () => {
  await handle.close();
});

/** The error the driver and drizzle between them really throw for a duplicate KEY-123 number. */
async function numberCollision(): Promise<unknown> {
  const first = await insertWorkItem(db, { workspaceId, projectId, title: "first" });
  try {
    await db
      .insert(schema.workItems)
      .values({ workspaceId, projectId, title: "same number", number: first.number });
  } catch (error) {
    return error;
  }
  throw new Error("the duplicate number was accepted");
}

/**
 * A handle whose first insert fails the way a concurrent writer makes it fail, and whose later ones
 * reach the database: the interleaving PGlite's single connection cannot produce by itself.
 */
function collidingOnce(real: Db, failure: unknown): { db: Db; inserts: () => number } {
  let inserts = 0;
  const wrapped = new Proxy(real, {
    get(target, property, receiver) {
      if (property === "insert") {
        return (...args: Parameters<Db["insert"]>) => {
          inserts += 1;
          if (inserts === 1) throw failure;
          return target.insert(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { db: wrapped, inserts: () => inserts };
}

describe("unique violations (X-data-03)", () => {
  test("recognised by code and constraint through drizzle's wrapper, never by the message", async () => {
    const error = await numberCollision();
    // What made the old check miss it: the message is the SQL, not the constraint.
    expect(error instanceof Error ? error.message : "").not.toContain("work_items_number_idx");
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(error, "work_items_number_idx")).toBe(true);
    expect(isUniqueViolation(error, "merge_queue_position_idx")).toBe(false);
  });

  test("postgres.js names the constraint differently, and an unwrapped error counts too", () => {
    const postgresJs = { code: "23505", constraint_name: "work_items_number_idx" };
    expect(isUniqueViolation(postgresJs, "work_items_number_idx")).toBe(true);
    expect(isUniqueViolation(new Error("wrapped", { cause: postgresJs }))).toBe(true);
    // Anything else is not one: another SQLSTATE, a plain error, nothing at all.
    expect(isUniqueViolation({ code: "23503", constraint: "work_items_number_idx" })).toBe(false);
    expect(isUniqueViolation(new Error("duplicate key value violates unique constraint"))).toBe(
      false,
    );
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });

  test("a work item whose number was taken first retries and takes the next one", async () => {
    const failure = await numberCollision();
    const { db: colliding, inserts } = collidingOnce(db, failure);
    const item = await insertWorkItem(colliding, { workspaceId, projectId, title: "retried" });
    expect(inserts()).toBe(2);
    const numbers = (await db.select({ n: schema.workItems.number }).from(schema.workItems)).map(
      (row) => row.n,
    );
    expect(item.number).toBe(Math.max(...numbers));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  test("a queue position that was taken first retries and takes the next one", async () => {
    const first = await enqueue(db, { workspaceId, projectId, branch: "perch/one", base: "main" });
    let failure: unknown = null;
    try {
      await db.insert(schema.mergeQueueEntries).values({
        workspaceId,
        projectId,
        branch: "perch/same-place",
        base: "main",
        position: first.position,
      });
    } catch (error) {
      failure = error;
    }
    expect(isUniqueViolation(failure, "merge_queue_position_idx")).toBe(true);
    const { db: colliding, inserts } = collidingOnce(db, failure);
    const second = await enqueue(colliding, {
      workspaceId,
      projectId,
      branch: "perch/two",
      base: "main",
    });
    expect(inserts()).toBe(2);
    expect(second.position).toBe(first.position + 1);
  });

  test("any other failure is not retried", async () => {
    const { db: colliding, inserts } = collidingOnce(db, new Error("the database went away"));
    await expect(
      insertWorkItem(colliding, { workspaceId, projectId, title: "not retried" }),
    ).rejects.toThrow("the database went away");
    expect(inserts()).toBe(1);
  });
});
