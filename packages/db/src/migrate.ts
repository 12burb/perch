import { sql } from "drizzle-orm";
import type { MigrationConfig, MigrationMeta } from "drizzle-orm/migrator";
import type { Db, DbHandle } from "./client.ts";
import { migrationSources } from "./migrations/index.ts";

/**
 * Embedded migrations (spec §9.1: generated with drizzle-kit, committed, run on boot under an advisory
 * lock, never edited once shipped). The SQL files are embedded at build time, so the compiled laptop binary
 * needs no migrations folder on disk. Concurrent api instances serialise on a session-level advisory lock
 * held on the single connection that also runs the migrations (`DbHandle.migrate` guarantees that binding);
 * drizzle's own `__drizzle_migrations` table decides what is pending.
 */

export const MIGRATIONS_TABLE = "__drizzle_migrations";
export const MIGRATION_LOCK_KEY = 7_331_003;

export function embeddedMigrations(): MigrationMeta[] {
  return migrationSources.map((m) => ({
    sql: m.sql.split("--> statement-breakpoint"),
    bps: m.breakpoints,
    folderMillis: m.when,
    hash: new Bun.CryptoHasher("sha256").update(m.sql).digest("hex"),
  }));
}

export type MigrateResult = { applied: number; total: number };

/**
 * drizzle's per-driver migrators call `db.dialect.migrate(migrations, db.session, config)`; both members
 * exist at runtime on every PgDatabase but are marked internal in the type declarations.
 */
type MigratableDb = {
  dialect: { migrate: (m: MigrationMeta[], s: unknown, c: MigrationConfig) => Promise<void> };
  session: unknown;
};

/** postgres.js returns an array; PGlite returns { rows }. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

async function appliedCount(db: Db): Promise<number> {
  const result = await db.execute(
    sql.raw(`select count(*)::int as n from drizzle."${MIGRATIONS_TABLE}"`),
  );
  return Number(rowsOf<{ n: number | string }>(result)[0]?.n ?? 0);
}

async function migrationsTableExists(db: Db): Promise<boolean> {
  const result = await db.execute(
    sql.raw(
      `select exists (select 1 from information_schema.tables where table_schema = 'drizzle' and table_name = '${MIGRATIONS_TABLE}') as ok`,
    ),
  );
  return Boolean(rowsOf<{ ok: boolean }>(result)[0]?.ok);
}

/** How many migrations have run on this database: 0 for one nothing has touched yet. */
export async function appliedMigrationCount(db: Db): Promise<number> {
  return (await migrationsTableExists(db)) ? await appliedCount(db) : 0;
}

/**
 * Applies pending migrations through `db`, which must be bound to exactly one connection so the advisory
 * lock and the migration statements share a session. Use `DbHandle.migrate()` instead of calling this
 * directly.
 */
export async function migrateOnOneConnection(db: Db): Promise<MigrateResult> {
  const migrations = embeddedMigrations();
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
  try {
    const before = (await migrationsTableExists(db)) ? await appliedCount(db) : 0;
    const internal = db as unknown as MigratableDb;
    await internal.dialect.migrate(migrations, internal.session, {
      migrationsFolder: "embedded",
      migrationsTable: MIGRATIONS_TABLE,
    });
    const after = await appliedCount(db);
    return { applied: after - before, total: migrations.length };
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
  }
}

/**
 * Applies only the first `count` embedded migrations, leaving the database at the schema Perch had
 * that many releases' worth of changes ago. The upgrade drill (task 4.10) uses it to get a database
 * at an older schema; a restore uses it (through `DbHandle.migrateTo`) to load an older backup at
 * the schema it was written at before migrating it forward (ADR-0175). Like `migrate`, the handle's
 * version runs on one dedicated connection.
 */
export async function migrateTo(db: Db, count: number): Promise<MigrateResult> {
  const migrations = embeddedMigrations().slice(0, count);
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
  try {
    const before = (await migrationsTableExists(db)) ? await appliedCount(db) : 0;
    const internal = db as unknown as MigratableDb;
    await internal.dialect.migrate(migrations, internal.session, {
      migrationsFolder: "embedded",
      migrationsTable: MIGRATIONS_TABLE,
    });
    return { applied: (await appliedCount(db)) - before, total: migrations.length };
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
  }
}

/** Runs the embedded migrations for a handle (boot-time entry point). */
export function runMigrations(handle: DbHandle): Promise<MigrateResult> {
  return handle.migrate();
}
