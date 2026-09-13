import { createDb, type DbHandle } from "./client.ts";

/**
 * PGlite test harness (spec §2: PGlite in memory for db tests). A fresh, migrated, in-memory database per
 * call; extensions loaded; nothing touches disk.
 */
export async function createTestDb(): Promise<DbHandle> {
  const handle = await createDb({ url: "pglite://memory" });
  await handle.migrate();
  return handle;
}

/**
 * The same harness on a real Postgres when PERCH_TEST_DATABASE_URL is set (the CI service container).
 * The database is reset (public and drizzle schemas dropped) before migrating, so only ever point it at a
 * throwaway database. Returns null when the variable is unset so suites can skip.
 */
export async function createPostgresTestDb(): Promise<DbHandle | null> {
  const url = process.env.PERCH_TEST_DATABASE_URL;
  if (!url) return null;
  const handle = await createDb({ url, maxConnections: 4 });
  await handle.db.execute(
    "drop schema if exists public cascade; create schema public; drop schema if exists drizzle cascade;",
  );
  await handle.migrate();
  return handle;
}
