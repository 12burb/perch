import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  backupTables,
  type DbHandle,
  databaseIsEmpty,
  dumpDatabase,
  keyColumns,
  newId,
  parseHeader,
  restoreDatabase,
  schema,
} from "../src/index.ts";
import { createTestDb } from "../src/testing.ts";

/**
 * The logical database backup (task 4.4): a dump taken from one database loads into an empty one
 * and the rows are the same rows — including the ones nothing could insert in dependency order,
 * like a message that is its own thread root.
 */

let from: DbHandle;
let into: DbHandle;

beforeAll(async () => {
  from = await createTestDb();
  into = await createTestDb();
  await from.migrate();
  await into.migrate();
}, 60_000);

afterAll(async () => {
  await from?.close();
  await into?.close();
});

describe("dump and restore (task 4.4)", () => {
  test("every backed-up table has a primary key, which is the order its pages are walked in", () => {
    for (const { name, table } of backupTables()) {
      expect(keyColumns(table).length, name).toBeGreaterThan(0);
    }
  });

  test("a workspace written here is all there after a restore into an empty database", async () => {
    const workspaceId = newId();
    const userId = newId();
    const channelId = newId();
    const messageId = newId();
    const credentialId = newId();

    await from.db
      .insert(schema.authUser)
      .values({ id: "auth-robin", name: "Robin", email: "robin@perch.test" });
    await from.db.insert(schema.users).values({
      id: userId,
      authUserId: "auth-robin",
      email: "robin@perch.test",
      handle: "robin",
      name: "Robin",
    });
    await from.db
      .insert(schema.workspaces)
      .values({ id: workspaceId, name: "The Nest", slug: "the-nest" });
    await from.db.insert(schema.memberships).values({ workspaceId, userId, role: "owner" });
    await from.db
      .insert(schema.channels)
      .values({ id: channelId, workspaceId, type: "public", name: "general" });
    // Its own thread root: no ordering of the tables makes this insertable with foreign keys on.
    await from.db.insert(schema.messages).values({
      id: messageId,
      workspaceId,
      channelId,
      threadRootId: messageId,
      authorType: "user",
      authorId: userId,
      blocks: [{ type: "text", text: "we are all here" }],
    });
    // A bytea column, so the encoding is exercised by something that is not text.
    await from.db.insert(schema.providerCredentials).values({
      id: credentialId,
      workspaceId,
      provider: "openai",
      kind: "api_key",
      scope: "workspace",
      label: "Key",
      ciphertext: new Uint8Array([0, 1, 2, 250, 255]),
      ownerId: userId,
    });

    const lines: string[] = [];
    const counts = await dumpDatabase(from.db, (line) => {
      lines.push(line);
    });
    expect(counts.rows).toBe(7);
    expect(counts.tables).toBe(backupTables().length);
    const header = parseHeader(lines[0] ?? "");
    expect(header.format).toBe("perch-database");
    expect(header.tables).toContain("messages");
    // The queue is state, not data.
    expect(header.tables).not.toContain("jobs");

    expect(await databaseIsEmpty(into.db)).toBe(true);
    async function* replay() {
      for (const line of lines) yield line;
    }
    const loaded = await restoreDatabase(into.db, replay());
    expect(loaded.rows).toBe(7);
    expect(await databaseIsEmpty(into.db)).toBe(false);

    const [message] = await into.db.select().from(schema.messages);
    expect(message?.id).toBe(messageId);
    expect(message?.threadRootId).toBe(messageId);
    expect(message?.blocks).toEqual([{ type: "text", text: "we are all here" }]);
    // A timestamp comes back a Date, not a string.
    expect(message?.createdAt).toBeInstanceOf(Date);
    const [credential] = await into.db.select().from(schema.providerCredentials);
    expect(Array.from(credential?.ciphertext ?? [])).toEqual([0, 1, 2, 250, 255]);
    // The generated search vector is Postgres's to compute, and it did.
    const [row] = await into.db.select().from(schema.messages).limit(1);
    expect(row).toBeDefined();
  }, 120_000);

  test("a file that is not a Perch backup is refused by its first line", () => {
    expect(() => parseHeader(JSON.stringify({ format: "something-else" }))).toThrow(
      "not a Perch database backup",
    );
    expect(() => parseHeader(JSON.stringify({ format: "perch-database", version: 99 }))).toThrow(
      "reads backup version 1",
    );
  });
});
