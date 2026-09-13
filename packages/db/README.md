# @perch/db

The normative schema (spec §6) as Drizzle tables, the jsonb shapes as Zod schemas, one `Db` type over
two drivers, embedded migrations, and the PGlite test harness.

```ts
import { createDb, schema, newId } from "@perch/db";

const handle = await createDb({ url: process.env.DATABASE_URL ?? "pglite://~/.perch/data" });
await handle.migrate(); // boot: advisory lock on one connection, __drizzle_migrations decides what is pending
const [ws] = await handle.db
  .insert(schema.workspaces)
  .values({ slug: "nest", name: "The Nest" })
  .returning();
```

- `createDb({ url })` opens `postgres://…` (postgres.js, team mode) or `pglite://<dir>` /
  `pglite://memory` (PGlite with pgvector and citext, laptop mode and tests). Both return the same
  `Db` type.
- `handle.migrate()` (also `runMigrations(handle)`) applies the SQL embedded in `src/migrations/index.ts`
  under a session-level `pg_advisory_lock` held on one dedicated connection, so several api instances can
  boot at once. The compiled `perch` binary needs no files on disk.
- `newId()` is UUID v7 (`Bun.randomUUIDv7()`), the `$defaultFn` of every `id` column.
- `createTestDb()` (from `@perch/db/testing`) gives a fresh, migrated, in-memory database per test file.
  `PERCH_TEST_DATABASE_URL` runs the same suite on a throwaway Postgres.

## Migrations

```sh
bun run db:generate     # drizzle-kit generate → drizzle/<tag>.sql, then embed into src/migrations/index.ts
bun run db:migrate      # apply to DATABASE_URL
```

Rules (spec §9.1): generated with drizzle-kit, committed, run on boot, never edited once shipped. A change
to the schema is a new migration, never an edit to an existing file. `0000_extensions.sql` is a custom
migration that creates the `citext` and `vector` extensions.

## Layout

| Path | What |
|---|---|
| `src/schema/*.ts` | tables by group: auth (better-auth's), identity, tenancy, projects, chat, files |
| `src/shapes/index.ts` | Zod schemas for every jsonb column |
| `src/columns.ts` | `citext`, `bytea`, `tsvector` custom types; `id()`, `timestamps()` helpers |
| `src/client.ts` | `createDb`, `Db`, `DbHandle` |
| `src/migrate.ts` | `runMigrations` over the embedded SQL |
| `src/testing.ts` | PGlite and Postgres test harnesses |
| `drizzle/` | generated SQL and drizzle-kit metadata |
