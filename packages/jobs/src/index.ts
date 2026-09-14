/**
 * @perch/jobs: the Postgres queue (spec §2, §6 jobs). Claims use `FOR UPDATE SKIP LOCKED`; a worker that
 * dies mid-job loses its lock after `lockTimeoutMs` and another worker reclaims the row; failures retry
 * with exponential backoff up to max_attempts; cron rows (croner) reschedule themselves after each run.
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

export function nextCronRun(expression: string, from: Date): Date {
  const next = new Cron(expression, { timezone: "UTC" }).nextRun(from);
  if (!next) throw new Error(`cron expression "${expression}" has no future run`);
  return next;
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
      const runAt = nextCronRun(o.cron, now());
      const [row] = await db
        .insert(jobs)
        .values({
          id: newId(),
          key: o.key,
          queue: o.queue,
          cron: o.cron,
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
            payload: o.payload ?? {},
            runAt,
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
        const runAt = nextCronRun(job.cron, now());
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
      await db
        .update(jobs)
        .set({
          lockedBy: null,
          lockedAt: null,
          lastError: message.slice(0, 4000),
          // Exhausted jobs keep their row for inspection; the claim query skips them.
          runAt: exhausted ? job.runAt : new Date(at.getTime() + backoffMs(job.attempts)),
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
          await queue.fail(job, error);
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

      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          abort.signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          });
        });

      return {
        id,
        start() {
          if (running) return;
          running = true;
          loop = (async () => {
            while (running) {
              let claimed = 0;
              while (running && inFlight < concurrency) {
                const job = await tick();
                if (!job) break;
                claimed += 1;
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
