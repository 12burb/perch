import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { id, timestamps, timestamptz } from "../columns.ts";

/**
 * The Postgres job queue (spec §6 jobs; spec §2 packages/jobs): SKIP LOCKED claims, retries with backoff,
 * cron rows that reschedule themselves. `key` (a small extension to the spec's column list, ADR-0041) gives
 * cron jobs a stable identity so `schedule()` is an upsert.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    queue: text("queue").notNull(),
    key: text("key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    runAt: timestamptz("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedBy: text("locked_by"),
    lockedAt: timestamptz("locked_at"),
    lastError: text("last_error"),
    cron: text("cron"),
    ...timestamps(),
  },
  (t) => [
    index("jobs_queue_run_at_idx").on(t.queue, t.runAt).where(sql`${t.lockedAt} is null`),
    uniqueIndex("jobs_key_idx").on(t.key).where(sql`${t.key} is not null`),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
