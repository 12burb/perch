import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  backupSchema,
  backupTables,
  createDb,
  type DbHandle,
  databaseIsEmpty,
  dumpDatabase,
  dumpGzipped,
  embeddedMigrations,
  keyColumns,
  migrateOnOneConnection,
  newId,
  openPglite,
  parseHeader,
  restoreDatabase,
  schema,
} from "../src/index.ts";
import { createTestDb } from "../src/testing.ts";

async function* replay(lines: string[]) {
  for (const line of lines) yield line;
}

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
    // The header says which schema the rows were read at.
    expect(header.migrations).toBe(embeddedMigrations().length);

    expect(await databaseIsEmpty(into.db)).toBe(true);
    const loaded = await restoreDatabase(into, replay(lines));
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
      "reads backup versions 1 and 2",
    );
  });

  test("pages are walked by key, never by offset, and every row comes out once", async () => {
    // An offset makes the database walk every row before the page again: quadratic on a table
    // like session_events, inside the one transaction that holds the snapshot.
    const queries: string[] = [];
    const pglite = openPglite();
    await pglite.waitReady;
    const logged = drizzle(pglite, {
      schema,
      logger: { logQuery: (query) => queries.push(query) },
    });
    try {
      await migrateOnOneConnection(logged);
      const ids = Array.from({ length: 7 }, () => newId());
      await logged
        .insert(schema.workspaces)
        .values(ids.map((id, n) => ({ id, name: `Nest ${n}`, slug: `nest-${n}` })));
      // A composite key too: memberships page by (workspace, user).
      await logged
        .insert(schema.authUser)
        .values({ id: "auth-k", name: "K", email: "k@perch.test" });
      const userId = newId();
      await logged.insert(schema.users).values({
        id: userId,
        authUserId: "auth-k",
        email: "k@perch.test",
        handle: "k",
        name: "K",
      });
      await logged
        .insert(schema.memberships)
        .values(ids.map((workspaceId) => ({ workspaceId, userId, role: "member" as const })));
      queries.length = 0;
      const lines: string[] = [];
      await dumpDatabase(
        logged,
        (line) => {
          lines.push(line);
        },
        { batch: 2 },
      );
      expect(queries.filter((query) => /\boffset\b/i.test(query))).toEqual([]);
      const rowsOf = (table: string) =>
        lines
          .slice(1)
          .map(
            (line) => JSON.parse(line) as { t: string; r: { id?: string; workspaceId?: string } },
          )
          .filter((record) => record.t === table);
      const workspaces = rowsOf("workspaces").map((record) => record.r.id);
      expect(new Set(workspaces).size).toBe(7);
      expect([...workspaces].sort()).toEqual([...ids].sort());
      const members = rowsOf("memberships").map((record) => record.r.workspaceId);
      expect(new Set(members).size).toBe(7);
      expect(members).toHaveLength(7);
    } finally {
      await pglite.close();
    }
  }, 60_000);

  test("the queue's schedules come back, unlocked; its one-off jobs do not", async () => {
    const source = await createTestDb();
    const target = await createTestDb();
    try {
      await source.db.insert(schema.jobs).values([
        {
          queue: "bots",
          key: "bot:digest:0",
          cron: "0 9 * * 1-5",
          timezone: "Europe/London",
          runAt: new Date("2026-09-25T08:00:00Z"),
          attempts: 3,
          lockedBy: "worker-gone",
          lockedAt: new Date("2026-09-24T08:00:00Z"),
          lastError: "the model timed out",
        },
        { queue: "system", payload: { kind: "supervisor.ensure" } },
      ]);
      // The target already scheduled its own copy of one key: that one is kept.
      await target.db.insert(schema.jobs).values({
        queue: "backups",
        key: "backup:nightly",
        cron: "0 4 * * *",
      });
      await source.db.insert(schema.jobs).values({
        queue: "backups",
        key: "backup:nightly",
        cron: "0 3 * * *",
      });
      const lines: string[] = [];
      await dumpDatabase(source.db, (line) => {
        lines.push(line);
      });
      // The target's own schedule does not make it "not empty".
      expect(await databaseIsEmpty(target.db)).toBe(true);
      await restoreDatabase(target, replay(lines));
      const jobs = await target.db.select().from(schema.jobs);
      expect(jobs.map((job) => job.key).sort()).toEqual(["backup:nightly", "bot:digest:0"]);
      const digest = jobs.find((job) => job.key === "bot:digest:0");
      expect(digest).toMatchObject({
        cron: "0 9 * * 1-5",
        timezone: "Europe/London",
        attempts: 0,
        lockedBy: null,
        lockedAt: null,
        lastError: null,
      });
      expect(digest?.runAt.toISOString()).toBe("2026-09-25T08:00:00.000Z");
      expect(jobs.find((job) => job.key === "backup:nightly")?.cron).toBe("0 4 * * *");
    } finally {
      await source.close();
      await target.close();
    }
  }, 60_000);
});

describe("a backup and the schema it was written at", () => {
  const current = embeddedMigrations().length;
  const header = (migrations: number | undefined, tables: string[] = []) =>
    JSON.stringify({
      format: "perch-database",
      version: migrations === undefined ? 1 : 2,
      createdAt: "2026-09-01T00:00:00.000Z",
      tables,
      ...(migrations === undefined ? {} : { migrations }),
    });
  /** The migration that added races and backfilled `unattended` (ADR-0133). */
  const RACES = embeddedMigrations().findIndex((m) =>
    m.sql.some((statement) => statement.includes('UPDATE "coding_sessions" SET "unattended"')),
  );

  test("a backup from a newer Perch is refused, not loaded with its new tables dropped", async () => {
    const target = await createDb({ url: "pglite://memory" });
    try {
      await expect(
        restoreDatabase(target, replay([header(current + 1, ["workspaces"])])),
      ).rejects.toThrow("newer Perch");
      // Nothing was touched: not even the migrations ran.
      expect(await databaseIsEmpty(target.db)).toBe(true);
    } finally {
      await target.close();
    }
  }, 60_000);

  test("an older backup loads at its own schema, and the data migrations since apply to it", async () => {
    expect(RACES).toBeGreaterThan(0);
    // Written before the column existed: a board-opened session, which 0032 marks unattended.
    const sessionId = newId();
    const lines = [
      header(RACES, ["coding_sessions"]),
      JSON.stringify({
        t: "coding_sessions",
        r: {
          id: sessionId,
          workspaceId: newId(),
          projectId: newId(),
          userId: newId(),
          engine: "opencode",
          modelProvider: "openai",
          modelId: "gpt",
          status: "idle",
          workItemId: newId(),
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      }),
    ];
    const target = await createDb({ url: "pglite://memory" });
    try {
      const restored = await restoreDatabase(target, replay(lines));
      expect(restored.schema).toEqual({ backup: RACES, current });
      const [session] = await target.db
        .select()
        .from(schema.codingSessions)
        .where(eq(schema.codingSessions.id, sessionId));
      expect(session?.unattended).toBe(true);
      // And the database finished at this build's schema.
      expect((await target.migrate()).applied).toBe(0);
    } finally {
      await target.close();
    }
  }, 60_000);

  test("an older backup is refused by a database already migrated past it, with what to do", async () => {
    const target = await createTestDb();
    try {
      await expect(restoreDatabase(target, replay([header(RACES, [])]))).rejects.toThrow(
        "no migration has run on",
      );
    } finally {
      await target.close();
    }
  }, 60_000);

  test("a version-1 header's schema is read off the tables its dump walked", () => {
    const every = backupTables()
      .map((one) => one.name)
      .filter((name) => name !== "jobs");
    // Everything a build before this one had: at most the forty migrations those builds carried.
    expect(backupSchema(parseHeader(header(undefined, every)))).toBe(Math.min(40, current));
    // A dump without the races tables was written before the migration that made them.
    const beforeRaces = every.filter((name) => !name.startsWith("race"));
    expect(backupSchema(parseHeader(header(undefined, beforeRaces)))).toBe(RACES);
  });
});

describe("writing a dump to a stream that fails", () => {
  test("an I/O error ends the dump with that error instead of waiting for ever", async () => {
    // The disk fills while the dump is written: the file stream errors, the gzip stream is torn
    // down, and a write that waits for "drain" on it would wait for ever.
    const source = await createTestDb();
    try {
      // Enough incompressible text that gzip has output to write before the dump ends.
      const noise = () => crypto.getRandomValues(new Uint8Array(96)).toHex();
      await source.db.insert(schema.workspaces).values(
        Array.from({ length: 3_000 }, (_, n) => ({
          name: `${noise()}`,
          slug: `nest-${n}-${noise().slice(0, 12)}`,
        })),
      );
      const failing = new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error("ENOSPC: no space left on device"));
        },
      });
      const outcome = await Promise.race([
        dumpGzipped(source.db, failing).then(
          () => "finished",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
        Bun.sleep(15_000).then(() => "still waiting"),
      ]);
      expect(outcome).toContain("ENOSPC");
    } finally {
      await source.close();
    }
  }, 60_000);
});
