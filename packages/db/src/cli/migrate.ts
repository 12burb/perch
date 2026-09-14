#!/usr/bin/env bun
/** `bun run db:migrate`: applies the embedded migrations to DATABASE_URL (defaults to laptop-mode PGlite). */
import { createDb } from "../client.ts";

const url = process.env.DATABASE_URL ?? "pglite://~/.perch/data";
const handle = await createDb({ url });
try {
  const result = await handle.migrate();
  console.log(
    `migrations: ${result.applied} applied, ${result.total} total (${handle.driver} at ${handle.location})`,
  );
} finally {
  await handle.close();
}
