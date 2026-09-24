import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import type { DbHandle } from "@perch/db";
import { createPostgresTestDb, createTestDb } from "@perch/db/testing";
import {
  abortableSleep,
  backoffMs,
  createQueue,
  knownTimezone,
  nextCronRun,
  type Queue,
} from "../src/index.ts";

/**
 * Task 0.6 acceptance for the queue: it survives a worker crash (an abandoned lock is reclaimed by another
 * worker) and cron fires (a scheduled row runs and reschedules itself). The suite runs on PGlite in memory
 * always and on Postgres when PERCH_TEST_DATABASE_URL is set (the CI service container): the two drivers
 * bind parameters differently (ADR-0061), so the claim query has to be exercised on both.
 */
function queueSuite(name: string, open: () => Promise<DbHandle | null>) {
  describe(`@perch/jobs queue on ${name}`, () => {
    let handle: DbHandle | null = null;
    let skipped = false;
    let clock = new Date("2026-09-13T10:00:00Z");
    const now = () => clock;
    let queue: Queue;

    beforeAll(async () => {
      handle = await open();
      skipped = handle === null;
      if (handle) queue = createQueue({ db: handle.db, now });
    }, 60_000);

    afterAll(async () => {
      await handle?.close();
    }, 30_000);

    test("enqueue → claim → complete removes the job; nothing is due twice", async () => {
      if (skipped) return;
      const job = await queue.enqueue({ queue: "email", payload: { to: "dawn@example.test" } });
      expect(job.attempts).toBe(0);
      const claimed = await queue.claim(["email"], "w1", 60_000);
      expect(claimed?.id).toBe(job.id);
      expect(claimed?.attempts).toBe(1);
      expect(claimed?.lockedBy).toBe("w1");
      expect(await queue.claim(["email"], "w2", 60_000)).toBeNull();
      if (claimed) await queue.complete(claimed);
      expect(await queue.get(job.id)).toBeNull();
    });

    test("the queue survives a worker crash: an abandoned lock is reclaimed after the lock timeout", async () => {
      if (skipped) return;
      const job = await queue.enqueue({ queue: "index", payload: { project: "p1" } });
      const first = await queue.claim(["index"], "crashed-worker", 60_000);
      expect(first?.id).toBe(job.id);
      // The worker dies without completing or failing the job. Within the timeout nobody may steal it…
      clock = new Date(clock.getTime() + 30_000);
      expect(await queue.claim(["index"], "w2", 60_000)).toBeNull();
      // …after the timeout another worker reclaims it and the attempt counter reflects the retry.
      clock = new Date(clock.getTime() + 31_000);
      const second = await queue.claim(["index"], "w2", 60_000);
      expect(second?.id).toBe(job.id);
      expect(second?.lockedBy).toBe("w2");
      expect(second?.attempts).toBe(2);
      if (second) await queue.complete(second);
    });

    test("a failing job retries with backoff and stops at max_attempts with the last error kept", async () => {
      if (skipped) return;
      const job = await queue.enqueue({ queue: "flaky", maxAttempts: 2 });
      const c1 = await queue.claim(["flaky"], "w1", 60_000);
      if (!c1) throw new Error("no claim");
      await queue.fail(c1, new Error("boom 1"));
      let row = await queue.get(job.id);
      expect(row?.lastError).toBe("boom 1");
      expect(row?.lockedBy).toBeNull();
      expect(row && row.runAt.getTime() - clock.getTime()).toBeGreaterThanOrEqual(1_500);
      // Not due yet.
      expect(await queue.claim(["flaky"], "w1", 60_000)).toBeNull();
      clock = new Date(clock.getTime() + 10_000);
      const c2 = await queue.claim(["flaky"], "w1", 60_000);
      expect(c2?.attempts).toBe(2);
      if (c2) await queue.fail(c2, new Error("boom 2"));
      row = await queue.get(job.id);
      expect(row?.lastError).toBe("boom 2");
      clock = new Date(clock.getTime() + 3_600_000);
      // Exhausted: the row stays for inspection but is never claimed again.
      expect(await queue.claim(["flaky"], "w1", 60_000)).toBeNull();
      expect(row?.attempts).toBe(2);
    });

    test("cron fires: a scheduled row runs when due and reschedules itself", async () => {
      if (skipped) return;
      clock = new Date("2026-09-14T08:59:30Z");
      const scheduled = await queue.schedule({
        key: "telemetry.ping",
        queue: "system",
        cron: "0 9 * * *",
        payload: { kind: "ping" },
      });
      expect(scheduled.runAt.toISOString()).toBe("2026-09-14T09:00:00.000Z");
      // Scheduling the same key again updates in place.
      const again = await queue.schedule({
        key: "telemetry.ping",
        queue: "system",
        cron: "0 9 * * *",
      });
      expect(again.id).toBe(scheduled.id);

      expect(await queue.claim(["system"], "w1", 60_000)).toBeNull();
      clock = new Date("2026-09-14T09:00:01Z");
      const ran: string[] = [];
      const worker = queue.worker({
        queues: ["system"],
        workerId: "cron-worker",
        handlers: {
          system: (job) => {
            ran.push(String(job.key));
          },
        },
      });
      const fired = await worker.tick();
      expect(fired?.key).toBe("telemetry.ping");
      expect(ran).toEqual(["telemetry.ping"]);
      const after = await queue.get(scheduled.id);
      expect(after?.runAt.toISOString()).toBe("2026-09-15T09:00:00.000Z");
      expect(after?.lockedBy).toBeNull();
      expect(after?.attempts).toBe(0);
      expect(await queue.unschedule("telemetry.ping")).toBe(true);
      expect(await queue.unschedule("telemetry.ping")).toBe(false);
    });

    test("a cron job that fails max_attempts times in a row is not dead: its next occurrence runs", async () => {
      if (skipped) return;
      // The nightly backup on a full disk: every attempt throws, the retries run out, and the
      // row used to stay exhausted until somebody restarted the api. One bad night costs one night.
      clock = new Date("2026-09-20T02:59:30Z");
      const scheduled = await queue.schedule({
        key: "nightly.flaky",
        queue: "nightly",
        cron: "0 3 * * *",
        maxAttempts: 2,
      });
      clock = new Date("2026-09-20T03:00:01Z");
      const c1 = await queue.claim(["nightly"], "w1", 60_000);
      if (!c1) throw new Error("no claim");
      await queue.fail(c1, new Error("disk full"));
      clock = new Date(clock.getTime() + 10_000);
      const c2 = await queue.claim(["nightly"], "w1", 60_000);
      if (!c2) throw new Error("no second claim");
      await queue.fail(c2, new Error("disk still full"));
      const after = await queue.get(scheduled.id);
      // Out of retries: the attempts start over at the next occurrence, and the failure stays
      // visible on the row.
      expect(after?.attempts).toBe(0);
      expect(after?.runAt.toISOString()).toBe("2026-09-21T03:00:00.000Z");
      expect(after?.lastError).toBe("disk still full");
      expect(after?.lockedBy).toBeNull();
      expect(await queue.claim(["nightly"], "w1", 60_000)).toBeNull();
      clock = new Date("2026-09-21T03:00:01Z");
      const next = await queue.claim(["nightly"], "w1", 60_000);
      expect(next?.id).toBe(scheduled.id);
      if (next) await queue.complete(next);
      await queue.unschedule("nightly.flaky");
    });

    test("scheduling the same cron again keeps a run that is already due", async () => {
      if (skipped) return;
      // The instance was off at three: the row is overdue when it boots, and boot schedules every
      // cron row again before the worker starts. The overdue night must still run.
      clock = new Date("2026-09-22T02:00:00Z");
      const first = await queue.schedule({
        key: "nightly.missed",
        queue: "missed",
        cron: "0 3 * * *",
      });
      expect(first.runAt.toISOString()).toBe("2026-09-22T03:00:00.000Z");
      clock = new Date("2026-09-22T08:00:00Z");
      const again = await queue.schedule({
        key: "nightly.missed",
        queue: "missed",
        cron: "0 3 * * *",
      });
      expect(again.id).toBe(first.id);
      expect(again.runAt.toISOString()).toBe("2026-09-22T03:00:00.000Z");
      const claimed = await queue.claim(["missed"], "w1", 60_000);
      expect(claimed?.id).toBe(first.id);
      if (claimed) await queue.complete(claimed);
      expect((await queue.get(first.id))?.runAt.toISOString()).toBe("2026-09-23T03:00:00.000Z");
      // A changed expression is a new schedule: the next run follows it, not the old one.
      const moved = await queue.schedule({
        key: "nightly.missed",
        queue: "missed",
        cron: "0 4 * * *",
      });
      expect(moved.runAt.toISOString()).toBe("2026-09-23T04:00:00.000Z");
      // And so is a changed zone.
      const zoned = await queue.schedule({
        key: "nightly.missed",
        queue: "missed",
        cron: "0 4 * * *",
        timezone: "America/New_York",
      });
      expect(zoned.runAt.toISOString()).toBe("2026-09-23T08:00:00.000Z");
      await queue.unschedule("nightly.missed");
    });

    test("a database error in the worker loop is reported and the loop keeps polling", async () => {
      if (skipped || !handle) return;
      clock = new Date("2026-09-24T12:00:00Z");
      // The database restarts under a running worker: one claim rejects. The loop must survive it
      // rather than end the process with an unhandled rejection.
      const flaky = createQueue({ db: handle.db, now });
      const realClaim = flaky.claim.bind(flaky);
      let calls = 0;
      flaky.claim = async (...args) => {
        calls += 1;
        if (calls === 1) throw new Error("connection terminated");
        return realClaim(...args);
      };
      const loopErrors: unknown[] = [];
      const done: string[] = [];
      await flaky.enqueue({ queue: "resilient", payload: { n: 1 } });
      const worker = flaky.worker({
        queues: ["resilient"],
        pollIntervalMs: 20,
        onLoopError: (error) => loopErrors.push(error),
        handlers: {
          resilient: (job) => {
            done.push(String(job.payload.n));
          },
        },
      });
      worker.start();
      const started = Date.now();
      while (done.length < 1 && Date.now() - started < 5_000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await worker.stop();
      expect(loopErrors.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([
        "connection terminated",
      ]);
      expect(calls).toBeGreaterThan(1);
      expect(done).toEqual(["1"]);
    });

    test("a job whose failure cannot be recorded does not take the worker down", async () => {
      if (skipped || !handle) return;
      clock = new Date("2026-09-24T13:00:00Z");
      const flaky = createQueue({ db: handle.db, now });
      flaky.fail = async () => {
        throw new Error("connection terminated while recording");
      };
      const loopErrors: unknown[] = [];
      const jobErrors: unknown[] = [];
      await flaky.enqueue({ queue: "unrecorded" });
      const worker = flaky.worker({
        queues: ["unrecorded"],
        pollIntervalMs: 20,
        onError: (error) => jobErrors.push(error),
        onLoopError: (error) => loopErrors.push(error),
        handlers: {
          unrecorded: () => {
            throw new Error("handler failed");
          },
        },
      });
      // tick() is what the loop calls: it resolves with the job instead of rejecting.
      const ran = await worker.tick();
      expect(ran).not.toBeNull();
      expect(jobErrors.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([
        "handler failed",
      ]);
      expect(loopErrors.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([
        "connection terminated while recording",
      ]);
      await worker.stop();
    });

    test("a worker's sleep leaves no listener on the abort signal behind (ADR-0165)", async () => {
      const abort = new AbortController();
      for (let i = 0; i < 25; i++) await abortableSleep(abort.signal, 1);
      expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
      // And an abort still ends a sleep early.
      const started = Date.now();
      const long = abortableSleep(abort.signal, 10_000);
      abort.abort();
      await long;
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    });

    test("the worker loop picks up due jobs and stops cleanly", async () => {
      if (skipped) return;
      clock = new Date("2026-09-14T12:00:00Z");
      const done: string[] = [];
      await queue.enqueue({ queue: "loop", payload: { n: 1 } });
      await queue.enqueue({ queue: "loop", payload: { n: 2 } });
      const worker = queue.worker({
        queues: ["loop"],
        pollIntervalMs: 20,
        handlers: {
          loop: async (job) => {
            done.push(String(job.payload.n));
          },
        },
      });
      worker.start();
      const started = Date.now();
      while (done.length < 2 && Date.now() - started < 5_000)
        await new Promise((r) => setTimeout(r, 10));
      await worker.stop();
      expect(done.sort()).toEqual(["1", "2"]);
    });
  });
}

queueSuite("pglite (in memory)", createTestDb);
queueSuite("postgres (PERCH_TEST_DATABASE_URL)", createPostgresTestDb);

describe("@perch/jobs helpers", () => {
  test("backoff grows exponentially with jitter and caps at an hour; cron parsing handles seconds", () => {
    expect(backoffMs(1, () => 0.5)).toBe(2_000);
    expect(backoffMs(2, () => 0.5)).toBe(4_000);
    expect(backoffMs(3, () => 0)).toBe(6_400);
    expect(backoffMs(30, () => 0.5)).toBe(3_600_000);
    expect(nextCronRun("*/15 * * * * *", new Date("2026-09-13T10:00:01Z")).toISOString()).toBe(
      "2026-09-13T10:00:15.000Z",
    );
    expect(() => nextCronRun("not a cron", new Date())).toThrow();
  });
});

/**
 * Task 3.5: a cron expression means an hour somewhere. "0 9 * * *" is nine in the morning where
 * whoever wrote it lives, which is a different instant in January than in July.
 */
describe("a cron expression with a zone", () => {
  const from = new Date("2026-01-15T00:00:00Z");

  test("is read in the zone it was given, not the machine's", () => {
    const london = nextCronRun("0 9 * * *", from, "Europe/London");
    const newYork = nextCronRun("0 9 * * *", from, "America/New_York");
    // Nine in London is 09:00 UTC in January; nine in New York is 14:00 UTC.
    expect(london.toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(newYork.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  test("follows the zone across a daylight-saving change", () => {
    const winter = nextCronRun("0 9 * * *", new Date("2026-01-15T00:00:00Z"), "Europe/London");
    const summer = nextCronRun("0 9 * * *", new Date("2026-07-15T00:00:00Z"), "Europe/London");
    expect(winter.getUTCHours()).toBe(9);
    // The same nine o'clock, an hour earlier in UTC, because London moved and the schedule did not.
    expect(summer.getUTCHours()).toBe(8);
  });

  test("falls back to UTC rather than throwing, and the queue refuses the typo up front", () => {
    expect(nextCronRun("0 9 * * *", from, "Mars/Olympus_Mons").toISOString()).toBe(
      "2026-01-15T09:00:00.000Z",
    );
    expect(knownTimezone("Europe/London")).toBe(true);
    expect(knownTimezone("Mars/Olympus_Mons")).toBe(false);
  });
});
