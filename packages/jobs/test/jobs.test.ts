import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DbHandle } from "@perch/db";
import { createTestDb } from "@perch/db/testing";
import { backoffMs, createQueue, nextCronRun, type Queue } from "../src/index.ts";

/**
 * Task 0.6 acceptance for the queue: it survives a worker crash (an abandoned lock is reclaimed by another
 * worker) and cron fires (a scheduled row runs and reschedules itself).
 */

let handle: DbHandle;
let clock = new Date("2026-09-13T10:00:00Z");
const now = () => clock;
let queue: Queue;

beforeAll(async () => {
  handle = await createTestDb();
  queue = createQueue({ db: handle.db, now });
}, 60_000);

afterAll(async () => {
  await handle.close();
});

describe("@perch/jobs Postgres queue", () => {
  test("enqueue → claim → complete removes the job; nothing is due twice", async () => {
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

  test("the worker loop picks up due jobs and stops cleanly", async () => {
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
