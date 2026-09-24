/**
 * @perch/jobs: the Postgres queue (spec §2, §6 jobs). Claims use `FOR UPDATE SKIP LOCKED`; a worker that
 * dies mid-job loses its lock after `lockTimeoutMs` and another worker reclaims the row; failures retry
 * with exponential backoff up to max_attempts; cron rows (croner) reschedule themselves after each run,
 * and after a run whose retries all failed, so a bad night costs that night and not the schedule
 * (ADR-0175).
 */
import { type Db, type Job, newId, schema } from "@perch/db";
import { Cron } from "croner";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

const { jobs } = schema;

export type JobPayload = Record<string, unknown>;

export type EnqueueOptions = {
  queue: string;
  payload?: JobPayload;
  runAt?: Date;
  maxAttempts?: number;
};

export type ScheduleOptions = {
  /** Stable identity: scheduling the same key again updates the row instead of adding one. */
  key: string;
  queue: string;
  /** croner expression; 5 fields or 6 with seconds. */
  cron: string;
  /**
   * The zone the expression is read in (task 3.5). "0 9 * * 1-5" means nine in the morning where
   * whoever wrote it lives, and that is a different instant in March than in July. UTC by default,
   * which is what every schedule made before this one meant.
   */
  timezone?: string;
  payload?: JobPayload;
  maxAttempts?: number;
};

export type JobHandler = (
  job: Job,
  ctx: { workerId: string; signal: AbortSignal },
) => Promise<void> | void;

export type WorkerOptions = {
  queues: string[];
  handlers: Record<string, JobHandler>;
  workerId?: string;
  pollIntervalMs?: number;
  /** A lock older than this is considered abandoned (crashed worker) and can be reclaimed. */
  lockTimeoutMs?: number;
  concurrency?: number;
  onError?: (error: unknown, job: Job) => void;
  /**
   * The queue itself failed (a claim, or recording a job's outcome), usually because the database
   * went away for a moment. The loop reports it here, sleeps one poll interval and carries on.
   */
  onLoopError?: (error: unknown) => void;
  now?: () => Date;
};

export type Worker = {
  readonly id: string;
  start(): void;
  stop(): Promise<void>;
  /** Claims and runs at most one job right now; returns it, or null when nothing is due. */
  tick(): Promise<Job | null>;
};

export type QueueOptions = {
  db: Db;
  now?: () => Date;
};

export type Queue = {
  enqueue(options: EnqueueOptions): Promise<Job>;
  schedule(options: ScheduleOptions): Promise<Job>;
  unschedule(key: string): Promise<boolean>;
  get(id: string): Promise<Job | null>;
  /** Claims one due job for a worker, or null. Exposed for tests and for the worker loop. */
  claim(queues: string[], workerId: string, lockTimeoutMs: number): Promise<Job | null>;
  complete(job: Job): Promise<void>;
  fail(job: Job, error: unknown): Promise<void>;
  worker(options: WorkerOptions): Worker;
};

/** Exponential backoff with jitter: 2s, 4s, 8s … capped at one hour. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(2_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Whether a zone name is one this runtime knows, so a typo is caught where it was written. */
export function knownTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export function nextCronRun(expression: string, from: Date, timezone = "UTC"): Date {
  const zone = knownTimezone(timezone) ? timezone : "UTC";
  const next = new Cron(expression, { timezone: zone }).nextRun(from);
  if (!next) throw new Error(`cron expression "${expression}" has no future run`);
  return next;
}

/** The next run, or null for an expression that has none left (a row that fails then stays put). */
function nextOccurrence(expression: string, from: Date, timezone: string | null): Date | null {
  try {
    return nextCronRun(expression, from, timezone ?? "UTC");
  } catch {
    return null;
  }
}

/**
 * A sleep that ends early on abort — and leaves nothing behind either way. The listener is
 * removed when the timer fires: a worker polls every second for the life of the process, and one
 * closure per poll kept on the same signal was a leak that grew for as long as it ran.
 */
export function abortableSleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createQueue(options: QueueOptions): Queue {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  const queue: Queue = {
    async enqueue(o) {
      const [row] = await db
        .insert(jobs)
        .values({
          id: newId(),
          queue: o.queue,
          payload: o.payload ?? {},
          runAt: o.runAt ?? now(),
          maxAttempts: o.maxAttempts ?? 5,
        })
        .returning();
      if (!row) throw new Error("enqueue returned no row");
      return row;
    },

    async schedule(o) {
      if (o.timezone && !knownTimezone(o.timezone)) {
        throw new Error(`"${o.timezone}" is not a time zone this machine knows`);
      }
      const timezone = o.timezone ?? "UTC";
      const runAt = nextCronRun(o.cron, now(), timezone);
      // Scheduling the same expression in the same zone again (every boot does) keeps a run that
      // is already due: an instance that was off at three still takes the night's backup when it
      // comes back. A changed expression or zone is a new schedule and moves the run (ADR-0175).
      const sameSchedule = sql`${jobs.cron} = excluded.cron and ${jobs.timezone} is not distinct from excluded.timezone`;
      const [row] = await db
        .insert(jobs)
        .values({
          id: newId(),
          key: o.key,
          queue: o.queue,
          cron: o.cron,
          timezone,
          payload: o.payload ?? {},
          runAt,
          maxAttempts: o.maxAttempts ?? 5,
        })
        .onConflictDoUpdate({
          target: jobs.key,
          targetWhere: sql`${jobs.key} is not null`,
          set: {
            queue: o.queue,
            cron: o.cron,
            timezone,
            payload: o.payload ?? {},
            runAt: sql`case when ${sameSchedule} then least(${jobs.runAt}, excluded.run_at) else excluded.run_at end`,
            attempts: 0,
            lastError: null,
          },
        })
        .returning();
      if (!row) throw new Error("schedule returned no row");
      return row;
    },

    async unschedule(key) {
      const deleted = await db.delete(jobs).where(eq(jobs.key, key)).returning({ id: jobs.id });
      return deleted.length > 0;
    },

    async get(id) {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
      return row ?? null;
    },

    async claim(queues, workerId, lockTimeoutMs) {
      if (queues.length === 0) return null;
      const at = now();
      const staleBefore = new Date(at.getTime() - lockTimeoutMs);
      // The operators bind `at` and `staleBefore` through the column encoders (ISO strings). A bare Date
      // inside a sql`` template reaches postgres.js unserialized and crashes the worker (ADR-0061).
      const due = db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            inArray(jobs.queue, queues),
            lte(jobs.runAt, at),
            lt(jobs.attempts, jobs.maxAttempts),
            or(isNull(jobs.lockedAt), lt(jobs.lockedAt, staleBefore)),
          ),
        )
        .orderBy(jobs.runAt)
        .limit(1)
        .for("update", { skipLocked: true });
      const [row] = await db
        .update(jobs)
        .set({
          lockedBy: workerId,
          lockedAt: at,
          attempts: sql`${jobs.attempts} + 1`,
          updatedAt: at,
        })
        .where(eq(jobs.id, due))
        .returning();
      return row ?? null;
    },

    async complete(job) {
      if (job.cron) {
        const runAt = nextCronRun(job.cron, now(), job.timezone ?? "UTC");
        await db
          .update(jobs)
          .set({
            lockedBy: null,
            lockedAt: null,
            attempts: 0,
            lastError: null,
            runAt,
            updatedAt: now(),
          })
          .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, job.lockedBy ?? "")));
        return;
      }
      await db.delete(jobs).where(eq(jobs.id, job.id));
    },

    async fail(job, error) {
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = job.attempts >= job.maxAttempts;
      const at = now();
      // A cron row out of retries starts over at its next occurrence rather than dying: the claim
      // query skips an exhausted row for ever, and a schedule that stopped because one night
      // failed would stop the backups (or the digest) with nobody told. lastError stays.
      const next = exhausted && job.cron ? nextOccurrence(job.cron, at, job.timezone) : null;
      await db
        .update(jobs)
        .set({
          lockedBy: null,
          lockedAt: null,
          lastError: message.slice(0, 4000),
          // Exhausted one-off jobs keep their row for inspection; the claim query skips them.
          runAt: next ?? (exhausted ? job.runAt : new Date(at.getTime() + backoffMs(job.attempts))),
          ...(next ? { attempts: 0 } : {}),
          updatedAt: at,
        })
        .where(eq(jobs.id, job.id));
    },

    worker(o) {
      const id = o.workerId ?? `worker-${newId().slice(-8)}`;
      const pollIntervalMs = o.pollIntervalMs ?? 1_000;
      const lockTimeoutMs = o.lockTimeoutMs ?? 60_000;
      const concurrency = o.concurrency ?? 1;
      const onError =
        o.onError ??
        ((error, job) => console.error(`[jobs] ${job.queue}/${job.id} failed:`, error));
      const onLoopError =
        o.onLoopError ?? ((error) => console.error("[jobs] the worker loop failed:", error));
      const abort = new AbortController();
      let running = false;
      let inFlight = 0;
      let loop: Promise<void> | null = null;

      const runJob = async (job: Job): Promise<void> => {
        const handler = o.handlers[job.queue];
        try {
          if (!handler) throw new Error(`no handler for queue ${job.queue}`);
          await handler(job, { workerId: id, signal: abort.signal });
          await queue.complete(job);
        } catch (error) {
          onError(error, job);
          try {
            await queue.fail(job, error);
          } catch (failed) {
            // The outcome could not be written (the database went away). The lock times out and
            // another claim retries the job; the worker itself carries on.
            onLoopError(failed);
          }
        }
      };

      const tick = async (): Promise<Job | null> => {
        const job = await queue.claim(o.queues, id, lockTimeoutMs);
        if (!job) return null;
        inFlight += 1;
        try {
          await runJob(job);
        } finally {
          inFlight -= 1;
        }
        return job;
      };

      const sleep = (ms: number) => abortableSleep(abort.signal, ms);

      return {
        id,
        start() {
          if (running) return;
          running = true;
          loop = (async () => {
            while (running) {
              let claimed = 0;
              try {
                while (running && inFlight < concurrency) {
                  const job = await tick();
                  if (!job) break;
                  claimed += 1;
                }
              } catch (error) {
                // Nobody awaits this loop until stop(), so an error leaving it would be an
                // unhandled rejection, and Bun ends the process on one. A database that restarts
                // under a running worker is ordinary: report it, wait a poll, and try again.
                onLoopError(error);
                claimed = 0;
              }
              if (claimed === 0) await sleep(pollIntervalMs);
            }
          })();
        },
        async stop() {
          running = false;
          abort.abort();
          await loop;
          loop = null;
        },
        tick,
      };
    },
  };
  return queue;
}
