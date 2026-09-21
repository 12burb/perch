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
 */
import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { getTableConfig, type PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "./client.ts";
import * as schema from "./schema/index.ts";

export const BACKUP_FORMAT = "perch-database";
export const BACKUP_VERSION = 1;

/**
 * The job queue is state, not data: restoring a week-old `supervisor.ensure` would start work
 * nobody asked for, and a queue that is empty after a restore is the correct queue.
 */
export const SKIPPED_TABLES = ["jobs"] as const;

export type BackupHeader = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  /** Every table this dump walked, in the order it walked them. */
  tables: string[];
};

export type BackupCounts = { tables: number; rows: number };

type Row = Record<string, unknown>;

/** Every table in the schema, by its SQL name, minus the ones a backup deliberately leaves out. */
export function backupTables(): { name: string; table: PgTable }[] {
  const tables: { name: string; table: PgTable }[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const name = getTableName(value);
    if ((SKIPPED_TABLES as readonly string[]).includes(name)) continue;
    tables.push({ name, table: value });
  }
  return tables.sort((a, b) => a.name.localeCompare(b.name));
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
): Promise<BackupCounts> {
  const batch = options.batch ?? 500;
  const tables = backupTables();
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    tables: tables.map((one) => one.name),
  };
  await write(`${JSON.stringify(header)}\n`);

  let rows = 0;
  await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read`);
    for (const { name, table } of tables) {
      // Paged in one total order: without it Postgres owes no stable order across two unordered
      // LIMIT/OFFSET reads (synchronized seqscans, parallel workers), and a page could repeat or
      // skip rows. The primary key is that order; every backed-up table has one (ADR-0165).
      const order = keyColumns(table);
      let offset = 0;
      for (;;) {
        const page = (await tx
          .select()
          .from(table)
          .orderBy(...order)
          .limit(batch)
          .offset(offset)) as Row[];
        for (const row of page) {
          const encoded: Row = {};
          for (const [field, value] of Object.entries(row)) encoded[field] = encode(value);
          await write(`${JSON.stringify({ t: name, r: encoded })}\n`);
          rows += 1;
        }
        if (page.length < batch) break;
        offset += batch;
      }
    }
  });
  return { tables: tables.length, rows };
}

export function parseHeader(line: string): BackupHeader {
  const header = JSON.parse(line) as Partial<BackupHeader>;
  if (header.format !== BACKUP_FORMAT) throw new Error("that is not a Perch database backup");
  if (header.version !== BACKUP_VERSION) {
    throw new Error(`this Perch reads backup version ${BACKUP_VERSION}, not ${header.version}`);
  }
  return header as BackupHeader;
}

/** Whether there is anything in here worth refusing to write over. */
export async function databaseIsEmpty(db: Db): Promise<boolean> {
  for (const { table } of backupTables()) {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(table).limit(1);
    if ((row?.count ?? 0) > 0) return false;
  }
  return true;
}

/**
 * Loads a dump into a database whose migrations have already run.
 *
 * Foreign keys are switched off for the load (`session_replication_role`), because a backup is a
 * consistent set of rows that was already valid — walking the tables in dependency order would
 * still leave self-referencing rows (a thread's root, a work item's parent) impossible to insert
 * in any order at all.
 */
export async function restoreDatabase(
  db: Db,
  lines: AsyncIterable<string>,
  options: { batch?: number } = {},
): Promise<BackupCounts> {
  const batch = options.batch ?? 500;
  const byName = new Map(backupTables().map((one) => [one.name, one.table]));
  let header: BackupHeader | null = null;
  let rows = 0;
  const seen = new Set<string>();

  await db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = 'replica'`);
    // The rows arrive table by table, so they are inserted a batch at a time rather than one by
    // one; the name and the table are kept beside the batch rather than in it, because a closure
    // that reassigns a captured object confuses narrowing for no gain.
    let batchName: string | null = null;
    let batchTable: PgTable | null = null;
    let pending: Row[] = [];

    const flush = async () => {
      if (!batchTable || pending.length === 0) return;
      await tx.insert(batchTable).values(pending);
      pending = [];
    };

    for await (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      if (!header) {
        header = parseHeader(text);
        continue;
      }
      const record = JSON.parse(text) as { t?: unknown; r?: unknown };
      if (typeof record.t !== "string" || !record.r || typeof record.r !== "object") {
        throw new Error("a line in this backup is not a row");
      }
      const table = byName.get(record.t);
      // A table this build no longer has is skipped rather than fatal: a restore from an older
      // Perch is worth more than a clean refusal.
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
      pending.push(row);
      seen.add(record.t);
      rows += 1;
      if (pending.length >= batch) await flush();
    }
    await flush();
  });

  if (!header) throw new Error("that backup has no header");
  return { tables: seen.size, rows };
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
