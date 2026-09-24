/**
 * A logical backup of everything Perch keeps in its database (task 4.4).
 *
 * The obvious way to back up Postgres is `pg_dump`, and the obvious way to back up PGlite is its
 * own data directory. Neither can be restored into the other, and a laptop that grows into a team
 * would find that out on the day it mattered — so a Perch backup is Perch's own rows, written as
 * JSON lines: a header, then one line per row, table by table. The schema comes back from the
 * migrations that are already embedded in the binary, and the data comes back from here. That also
 * means the format needs no client binaries in the image, and a backup taken in laptop mode
 * restores into Postgres exactly as it restores into PGlite.
 *
 * Values are encoded by what they are and decoded by what the column says it is: a timestamp is an
 * ISO string, `bytea` is base64, everything else is plain JSON.
 *
 * The header says which schema the rows were read at (how many migrations had run). A restore
 * refuses a backup from a newer schema, and loads an older one at its own schema before migrating
 * forward, so the data migrations in between apply to its rows as they would have in an upgrade
 * (ADR-0175).
 */
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { and, getTableColumns, getTableName, gt, is, isNotNull, type SQL, sql } from "drizzle-orm";
import { getTableConfig, type PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Db, DbHandle } from "./client.ts";
import { appliedMigrationCount, embeddedMigrations } from "./migrate.ts";
import { migrationSources } from "./migrations/index.ts";
import * as schema from "./schema/index.ts";

export const BACKUP_FORMAT = "perch-database";
/** 2 adds the schema (`migrations`) to the header and the job schedules to the rows. */
export const BACKUP_VERSION = 2;

/**
 * The job queue is state, not data: restoring a week-old `supervisor.ensure` would start work
 * nobody asked for, and a queue that is empty after a restore is the correct queue. Its schedules
 * are configuration, though — a bot's cron trigger lives nowhere but its row — so the rows that
 * carry a cron expression are kept, and come back unlocked with their attempts at zero.
 */
const SCHEDULES_ONLY = "jobs";

/**
 * Every dump written before the header carried its schema came from a build with at most this many
 * migrations (0000–0039). A fixed fact about the past: it never changes when migrations are added.
 */
const LEGACY_SCHEMA_CEILING = 40;

const headerSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.union([z.literal(1), z.literal(2)]),
  createdAt: z.string(),
  /** Every table this dump walked, in the order it walked them. */
  tables: z.array(z.string()),
  /** How many migrations had run on the database the rows were read from (version 2). */
  migrations: z.number().int().nonnegative().optional(),
});

export type BackupHeader = z.infer<typeof headerSchema>;

export type BackupCounts = { tables: number; rows: number };

/** What a dump wrote, and the schema it read the rows at. */
export type DumpCounts = BackupCounts & { migrations: number };

export type RestoreResult = BackupCounts & {
  /** The schema the backup was written at, and the one this build migrates to. */
  schema: { backup: number; current: number };
};

type Row = Record<string, unknown>;

/** Every table in the schema, by its SQL name. */
export function backupTables(): { name: string; table: PgTable }[] {
  const tables: { name: string; table: PgTable }[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    tables.push({ name: getTableName(value), table: value });
  }
  return tables.sort((a, b) => a.name.localeCompare(b.name));
}

/** Which of a table's rows a backup carries: all of them, or for the queue only its schedules. */
function rowsKept(name: string): SQL | undefined {
  return name === SCHEDULES_ONLY ? isNotNull(schema.jobs.cron) : undefined;
}

/** A generated column is computed by Postgres; writing one back is an error, not a restore. */
function writableColumns(table: PgTable): Record<string, PgColumn> {
  const columns: Record<string, PgColumn> = {};
  for (const [field, column] of Object.entries(getTableColumns(table))) {
    if ((column as { generated?: unknown }).generated) continue;
    columns[field] = column;
  }
  return columns;
}

/** The columns that give a table one total order: its primary key. */
export function keyColumns(table: PgTable): PgColumn[] {
  const config = getTableConfig(table);
  const composite = config.primaryKeys[0]?.columns;
  if (composite && composite.length > 0) return [...composite];
  const single = config.columns.filter((column) => column.primary);
  if (single.length > 0) return single;
  throw new Error(`${config.name} has no primary key to page by`);
}

/**
 * The rows after `last` in key order: `(k1, k2) > ($1, $2)`, which walks the primary key's index
 * from where the previous page stopped. Values are bound through their columns' encoders (ADR-0061).
 */
function after(order: PgColumn[], fields: string[], last: Row): SQL {
  const [only] = order;
  const [field] = fields;
  if (order.length === 1 && only && field) return gt(only, last[field]);
  const keys = sql.join(order, sql`, `);
  const values = sql.join(
    order.map((column, index) => sql.param(last[fields[index] ?? ""], column)),
    sql`, `,
  );
  return sql`(${keys}) > (${values})`;
}

function encode(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

function decode(value: unknown, column: PgColumn): unknown {
  if (value === null || value === undefined) return null;
  const type = column.getSQLType();
  if (type.startsWith("timestamp") || type === "date") {
    return typeof value === "string" ? new Date(value) : value;
  }
  if (type === "bytea") {
    return typeof value === "string" ? new Uint8Array(Buffer.from(value, "base64")) : value;
  }
  return value;
}

export type DumpLine =
  | { type: "header"; header: BackupHeader }
  | { type: "row"; table: string; row: Row };

/**
 * Walks every table and hands each line to `write`. One repeatable-read transaction, so the backup
 * is one moment rather than a smear across however long the walk takes.
 */
export async function dumpDatabase(
  db: Db,
  write: (line: string) => void | Promise<void>,
  options: { batch?: number; now?: () => Date } = {},
): Promise<DumpCounts> {
  const batch = options.batch ?? 500;
  const tables = backupTables();
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    tables: tables.map((one) => one.name),
    migrations: await appliedMigrationCount(db),
  };
  await write(`${JSON.stringify(header)}\n`);

  let rows = 0;
  await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read`);
    for (const { name, table } of tables) {
      // Paged in one total order, the primary key, and by key rather than by offset: an offset
      // makes the database walk every row before the page again, which is quadratic on a table
      // like session_events, all inside the one transaction that holds the snapshot (ADR-0175).
      const order = keyColumns(table);
      const byColumn = new Map(
        Object.entries(getTableColumns(table)).map(([field, column]) => [column, field]),
      );
      const fields = order.map((column) => byColumn.get(column) ?? "");
      const kept = rowsKept(name);
      let last: Row | null = null;
      for (;;) {
        const where = and(kept, last ? after(order, fields, last) : undefined);
        const page = (await tx
          .select()
          .from(table)
          .where(where)
          .orderBy(...order)
          .limit(batch)) as Row[];
        for (const row of page) {
          const encoded: Row = {};
          for (const [field, value] of Object.entries(row)) encoded[field] = encode(value);
          await write(`${JSON.stringify({ t: name, r: encoded })}\n`);
          rows += 1;
        }
        if (page.length < batch) break;
        last = page[page.length - 1] ?? null;
      }
    }
  });
  return { tables: tables.length, rows, migrations: header.migrations ?? 0 };
}

export function parseHeader(line: string): BackupHeader {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("that is not a Perch database backup");
  }
  const fields = (raw ?? {}) as { format?: unknown; version?: unknown };
  if (fields.format !== BACKUP_FORMAT) throw new Error("that is not a Perch database backup");
  if (fields.version !== 1 && fields.version !== 2) {
    throw new Error(`this Perch reads backup versions 1 and 2, not ${String(fields.version)}`);
  }
  const parsed = headerSchema.safeParse(raw);
  if (!parsed.success) throw new Error("that backup's header is not one this Perch can read");
  return parsed.data;
}

/**
 * The schema a backup's rows were written at. A version-1 header does not say, so it is read off
 * the tables the dump walked: the migrations before the first one that created a table the dump
 * does not have. The queue was not in version-1 dumps at all, so it says nothing either way.
 */
export function backupSchema(header: BackupHeader): number {
  if (header.migrations !== undefined) return header.migrations;
  const walked = new Set(header.tables);
  let count = 0;
  for (const source of migrationSources.slice(0, LEGACY_SCHEMA_CEILING)) {
    const created = [...source.sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"([a-z0-9_]+)"/g)]
      .map((match) => match[1] ?? "")
      .filter((name) => name !== SCHEDULES_ONLY);
    if (created.some((name) => !walked.has(name))) break;
    count += 1;
  }
  return count;
}

/**
 * Whether there is anything in here worth refusing to write over. The queue does not count (an
 * instance schedules its own nightly rows at boot), and neither does a table this database does
 * not have yet — one nothing has migrated is as empty as a database gets.
 */
export async function databaseIsEmpty(db: Db): Promise<boolean> {
  const present = await db.execute(
    sql`select table_name as name from information_schema.tables where table_schema = 'public'`,
  );
  const list = Array.isArray(present) ? present : ((present as { rows?: unknown[] }).rows ?? []);
  const existing = new Set(list.map((row) => String((row as { name?: unknown }).name)));
  for (const { name, table } of backupTables()) {
    if (name === SCHEDULES_ONLY || !existing.has(name)) continue;
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(table).limit(1);
    if ((row?.count ?? 0) > 0) return false;
  }
  return true;
}

/**
 * One batch of rows, naming only the columns the rows carry. A backup from an older schema is
 * loaded at that schema, where a column this build has added does not exist yet; a column a row
 * leaves out takes its default, as it would have when the row was first written.
 */
async function insertRows(
  tx: Pick<Db, "execute">,
  table: PgTable,
  columns: Record<string, PgColumn>,
  rows: Row[],
  skipConflicts: boolean,
): Promise<void> {
  const fields = Object.keys(columns).filter((field) =>
    rows.some((row) => row[field] !== undefined),
  );
  const conflict = skipConflicts ? sql` on conflict do nothing` : sql``;
  if (fields.length === 0) {
    for (const _ of rows) await tx.execute(sql`insert into ${table} default values${conflict}`);
    return;
  }
  const names = sql.join(
    fields.map((field) => sql.identifier(columns[field]?.name ?? field)),
    sql`, `,
  );
  const values = sql.join(
    rows.map(
      (row) =>
        sql`(${sql.join(
          fields.map((field) => {
            const column = columns[field];
            const value = row[field];
            return value === undefined || !column ? sql`default` : sql.param(value, column);
          }),
          sql`, `,
        )})`,
    ),
    sql`, `,
  );
  await tx.execute(sql`insert into ${table} (${names}) values ${values}${conflict}`);
}

/** A restored schedule is a schedule, not a run in progress: unlocked, attempts at zero. */
function asRestored(name: string, row: Row): Row {
  if (name !== SCHEDULES_ONLY) return row;
  return { ...row, lockedBy: null, lockedAt: null, attempts: 0, lastError: null };
}

/**
 * Loads a dump into a database, at the schema the dump was written at, and migrates it forward.
 *
 * - A backup from a newer schema than this build knows is refused: loading it would drop every
 *   table and column this build does not have, and report success.
 * - A database no migration has reached the backup's schema on (a fresh one) is migrated up to it
 *   first, loaded, and then migrated forward, so the data migrations in between apply to these
 *   rows as they would have in an upgrade.
 * - A database already past the backup's schema cannot be loaded at it, and is refused with what
 *   to do instead. One at the same schema (the usual case: the same release) is loaded as it is.
 *
 * Foreign keys are switched off for the load (`session_replication_role`), because a backup is a
 * consistent set of rows that was already valid — walking the tables in dependency order would
 * still leave self-referencing rows (a thread's root, a work item's parent) impossible to insert
 * in any order at all.
 */
export async function restoreDatabase(
  target: DbHandle,
  lines: AsyncIterable<string>,
  options: { batch?: number } = {},
): Promise<RestoreResult> {
  const batch = options.batch ?? 500;
  const byName = new Map(backupTables().map((one) => [one.name, one.table]));
  const iterator = lines[Symbol.asyncIterator]();
  let header: BackupHeader | null = null;
  while (!header) {
    const next = await iterator.next();
    if (next.done) throw new Error("that backup has no header");
    const text = next.value.trim();
    if (text) header = parseHeader(text);
  }

  const current = embeddedMigrations().length;
  const written = backupSchema(header);
  if (written > current) {
    throw new Error(
      `this backup was taken at schema ${written}, by a newer Perch than this one (schema ${current}); restore it with that release or a later one`,
    );
  }
  const applied = await appliedMigrationCount(target.db);
  if (applied > written) {
    throw new Error(
      `this database is already at schema ${applied}, past the backup's ${written}; restore it into a database no migration has run on, so its rows load at their own schema and migrate forward`,
    );
  }
  if (applied < written) await target.migrateTo(written);

  let rows = 0;
  const seen = new Set<string>();
  await target.db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = 'replica'`);
    // The rows arrive table by table, so they are inserted a batch at a time rather than one by
    // one; the name and the table are kept beside the batch rather than in it, because a closure
    // that reassigns a captured object confuses narrowing for no gain.
    let batchName: string | null = null;
    let batchTable: PgTable | null = null;
    let pending: Row[] = [];

    const flush = async () => {
      if (!batchTable || !batchName || pending.length === 0) return;
      // A schedule the instance already made for itself (its nightly backup) is kept.
      await insertRows(
        tx,
        batchTable,
        writableColumns(batchTable),
        pending,
        batchName === SCHEDULES_ONLY,
      );
      pending = [];
    };

    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const text = next.value.trim();
      if (!text) continue;
      const record = JSON.parse(text) as { t?: unknown; r?: unknown };
      if (typeof record.t !== "string" || !record.r || typeof record.r !== "object") {
        throw new Error("a line in this backup is not a row");
      }
      const table = byName.get(record.t);
      // A table this build does not have is skipped rather than fatal; with the schema check above
      // that is only ever a table a migration since has dropped.
      if (!table) continue;
      if (batchName !== record.t) {
        await flush();
        batchName = record.t;
        batchTable = table;
      }
      const columns = writableColumns(table);
      const row: Row = {};
      for (const [field, column] of Object.entries(columns)) {
        const value = (record.r as Row)[field];
        if (value === undefined) continue;
        row[field] = decode(value, column);
      }
      pending.push(asRestored(record.t, row));
      seen.add(record.t);
      rows += 1;
      if (pending.length >= batch) await flush();
    }
    await flush();
  });

  if (written < current) await target.migrate();
  return { tables: seen.size, rows, schema: { backup: written, current } };
}

/** Reads a stream of bytes as lines, without holding the whole file in memory. */
export async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    carry += decoder.decode(chunk, { stream: true });
    let index = carry.indexOf("\n");
    while (index >= 0) {
      yield carry.slice(0, index);
      carry = carry.slice(index + 1);
      index = carry.indexOf("\n");
    }
  }
  carry += decoder.decode();
  if (carry.trim()) yield carry;
}

/**
 * The dump, gzipped, into `out`: the one way both backup writers (the api and `perch backup`) put
 * it on disk. An error on `out` (a full disk) tears the pipeline down; the wait for "drain" is
 * raced against the pipeline so that error ends the dump, where on its own it would wait for a
 * "drain" a destroyed stream never emits. The pipeline's rejection is handled from the start, and
 * awaited again at the end, so it is reported rather than left unhandled (ADR-0175).
 */
export async function dumpGzipped(
  db: Db,
  out: Writable,
  options: { batch?: number; now?: () => Date } = {},
): Promise<DumpCounts> {
  const gzip = createGzip();
  const done = pipeline(gzip, out);
  done.catch(() => {});
  const counts = await dumpDatabase(
    db,
    async (line) => {
      if (gzip.write(line)) return;
      await Promise.race([
        new Promise<void>((resolve) => gzip.once("drain", () => resolve())),
        done,
      ]);
    },
    options,
  );
  gzip.end();
  await done;
  return counts;
}
