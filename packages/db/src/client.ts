import { homedir } from "node:os";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { vector } from "@electric-sql/pglite-pgvector";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { type MigrateResult, migrateOnOneConnection } from "./migrate.ts";
import * as schema from "./schema/index.ts";

export type Schema = typeof schema;

/** One database type over both drivers (spec §2): services and repositories only ever see this. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export type DbDriver = "postgres" | "pglite";

export type DbHandle = {
  db: Db;
  driver: DbDriver;
  /** The connection string or data directory the handle was opened with, with secrets redacted. */
  location: string;
  /** Applies pending embedded migrations under an advisory lock on a single dedicated connection. */
  migrate: () => Promise<MigrateResult>;
  close: () => Promise<void>;
};

export type CreateDbOptions = {
  /** `postgres://…` (team mode) or `pglite://<dir>` / `pglite://memory` (laptop mode and tests). */
  url: string;
  /** postgres.js pool size; ignored for PGlite. */
  maxConnections?: number;
};

const PGLITE_PREFIX = "pglite://";

export function isPgliteUrl(url: string): boolean {
  return url.startsWith(PGLITE_PREFIX);
}

/** Resolves `pglite://~/.perch/data` style locations; `memory` means an in-memory database. */
export function pgliteDataDir(url: string): string | undefined {
  const raw = url.slice(PGLITE_PREFIX.length);
  if (raw === "" || raw === "memory" || raw === ":memory:") return undefined;
  const expanded = raw.startsWith("~") ? `${homedir()}${raw.slice(1)}` : raw;
  return resolve(expanded);
}

/**
 * Opens a PGlite database with the extensions the schema needs (pgvector, citext). `loadDataDir`
 * restores a `dumpDataDir()` tarball into a fresh data directory (perch restore).
 */
export function openPglite(dataDir?: string, options: { loadDataDir?: Blob | File } = {}): PGlite {
  const extensions = { vector, citext };
  const extra = options.loadDataDir ? { loadDataDir: options.loadDataDir } : {};
  return dataDir
    ? new PGlite(dataDir, { extensions, ...extra })
    : new PGlite({ extensions, ...extra });
}

export async function createDb(options: CreateDbOptions): Promise<DbHandle> {
  if (isPgliteUrl(options.url)) {
    const dataDir = pgliteDataDir(options.url);
    const pglite = openPglite(dataDir);
    await pglite.waitReady;
    const db = drizzlePglite(pglite, { schema });
    return {
      db,
      driver: "pglite",
      location: dataDir ?? "memory",
      // PGlite is a single connection, so the pool handle is the migration connection.
      migrate: () => migrateOnOneConnection(db),
      close: () => pglite.close(),
    };
  }
  const client = postgres(options.url, {
    max: options.maxConnections ?? 10,
    onnotice: () => {},
  });
  const db = drizzlePostgres(client, { schema });
  return {
    db,
    driver: "postgres",
    location: redactUrl(options.url),
    migrate: async () => {
      // A dedicated one-connection client so the advisory lock and the DDL share a session.
      const single = postgres(options.url, { max: 1, onnotice: () => {} });
      try {
        return await migrateOnOneConnection(drizzlePostgres(single, { schema }));
      } finally {
        await single.end({ timeout: 5 });
      }
    },
    close: () => client.end({ timeout: 5 }),
  };
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "postgres://***";
  }
}
