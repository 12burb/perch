/**
 * The jobs a bot's schedules are (spec §5.3 `schedule (cron)`; task 3.5). The queue owns these
 * rows; this only reads them, so a list of schedules can say when each one next fires.
 */
import { type Db, schema } from "@perch/db";
import { like } from "drizzle-orm";

const { jobs } = schema;

export type ScheduledJob = {
  key: string;
  cron: string;
  timezone: string | null;
  runAt: Date;
  attempts: number;
  lastError: string | null;
};

/** Every cron row belonging to one bot, by the `bot:<id>:<index>` key `reschedule` writes. */
export async function scheduledJobsFor(db: Db, botId: string): Promise<ScheduledJob[]> {
  const rows = await db
    .select({
      key: jobs.key,
      cron: jobs.cron,
      timezone: jobs.timezone,
      runAt: jobs.runAt,
      attempts: jobs.attempts,
      lastError: jobs.lastError,
    })
    .from(jobs)
    .where(like(jobs.key, `bot:${botId}:%`));
  const out: ScheduledJob[] = [];
  for (const row of rows) {
    if (!row.key || !row.cron) continue;
    out.push({
      key: row.key,
      cron: row.cron,
      timezone: row.timezone,
      runAt: row.runAt,
      attempts: row.attempts,
      lastError: row.lastError,
    });
  }
  return out;
}
