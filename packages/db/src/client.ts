import { homedir } from "node:os";
import { resolve } from "node:path";
import { type Extension, PGlite } from "@electric-sql/pglite";
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
  /** Embedded PGlite runtime files (the compiled perch binary); ignored for Postgres. */
  pglite?: PgliteRuntime;
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
 * How PGlite finds its runtime: by default next to its module (pglite.wasm, initdb.wasm, pglite.data,
 * and the extension tarballs). A compiled perch binary embeds those files and passes them here
 * (ADR-0060). `loadDataDir` restores a `dumpDataDir()` tarball into a fresh directory (perch restore).
 */
export type PgliteRuntime = {
  pgliteWasmModule?: WebAssembly.Module;
  initdbWasmModule?: WebAssembly.Module;
  fsBundle?: Blob | File;
  /** Replacements for the default vector and citext extensions (same names, embedded bundles). */
  extensions?: { vector: Extension; citext: Extension };
  loadDataDir?: Blob | File;
};

/**
 * How long a closing PGlite waits for the queries it already started (ADR-0109). Long enough for
 * any statement Perch issues, short enough that a wedged one does not hold a shutdown open.
 */
export const PGLITE_DRAIN_MS = 5_000;

/**
 * PGlite's `close()` spins forever — a `for(;;)` in its own `execProtocolRawSync` — when a query is
 * still in flight, so the process pins a core and grows without bound instead of shutting down
 * (ADR-0109). Perch cannot fix that from here, and it cannot promise that nothing anywhere ever
 * starts a write during teardown: a socket closing, a subscriber finishing, a fire-and-forget
 * `.catch()` are all ordinary.
 *
 * So the handle itself is made ordering-insensitive. It counts what it has started, `close()` waits
 * for that to finish before it closes anything, and anything that arrives after closing has begun is
 * refused with a sentence rather than admitted into a database that is going away.
 */
function guardClosing(pglite: PGlite): { closing: () => Promise<void>; refuseFrom: () => void } {
  const inFlight = new Set<Promise<unknown>>();
  let refusing = false;
  for (const name of ["query", "exec", "transaction"] as const) {
    const original = pglite[name];
    if (typeof original !== "function") continue;
    const wrapped = (...args: unknown[]): unknown => {
      if (refusing) {
        return Promise.reject(new Error("the database is closing; this query was not run"));
      }
      // biome-ignore lint/suspicious/noExplicitAny: PGlite's overloads differ per method
      const out = (original as any).apply(pglite, args) as unknown;
      if (!out || typeof (out as Promise<unknown>).finally !== "function") return out;
      const tracked = out as Promise<unknown>;
      inFlight.add(tracked);
      // The caller keeps the original promise, rejection and all; this copy is only for counting.
      void tracked.then(
        () => inFlight.delete(tracked),
        () => inFlight.delete(tracked),
      );
      return tracked;
    };
    // biome-ignore lint/suspicious/noExplicitAny: replacing a method on a third-party instance
    (pglite as any)[name] = wrapped;
  }
  return {
    refuseFrom: () => {
      refusing = true;
    },
    closing: async () => {
      const until = Date.now() + PGLITE_DRAIN_MS;
      while (inFlight.size > 0 && Date.now() < until) {
        // Raced against what is left of the deadline: a transaction whose callback never settles
        // keeps its promise pending for ever, and awaiting it alone would make the deadline
        // bound nothing.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled([...inFlight]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(0, until - Date.now()));
          }),
        ]);
        clearTimeout(timer);
      }
    },
  };
}

/** Opens a PGlite database with the extensions the schema needs (pgvector, citext). */
export function openPglite(dataDir?: string, runtime: PgliteRuntime = {}): PGlite {
  const { extensions, loadDataDir, ...modules } = runtime;
  const options = {
    extensions: extensions ?? { vector, citext },
    ...(loadDataDir ? { loadDataDir } : {}),
    ...modules,
  };
  return dataDir ? new PGlite(dataDir, options) : new PGlite(options);
}

export async function createDb(options: CreateDbOptions): Promise<DbHandle> {
  if (isPgliteUrl(options.url)) {
    const dataDir = pgliteDataDir(options.url);
    const pglite = openPglite(dataDir, options.pglite);
    await pglite.waitReady;
    const guard = guardClosing(pglite);
    const db = drizzlePglite(pglite, { schema });
    return {
      db,
      driver: "pglite",
      location: dataDir ?? "memory",
      // PGlite is a single connection, so the pool handle is the migration connection.
      migrate: () => migrateOnOneConnection(db),
      close: async () => {
        // Whatever was already running finishes; whatever comes after is refused (ADR-0109).
        await guard.closing();
        guard.refuseFrom();
        await pglite.close();
      },
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
