import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDb, PGLITE_DRAIN_MS } from "../src/client.ts";

/**
 * A closing PGlite handle waits for what it already started, for a while, and then closes anyway
 * (ADR-0109). "For a while" has to be a bound: a transaction whose callback never settles keeps its
 * promise pending for ever, and a drain that awaits it would hold a shutdown open with it.
 */
describe("closing a PGlite handle", () => {
  test("a query that never settles holds close() for the drain deadline, not for ever", async () => {
    const handle = await createDb({ url: "pglite://memory" });
    // A transaction whose callback waits on something that never happens.
    const wedged = handle.db.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      await new Promise(() => {});
    });
    void wedged.catch(() => {});
    await Bun.sleep(50);
    const started = Date.now();
    const closed = await Promise.race([
      handle.close().then(() => "closed" as const),
      Bun.sleep(PGLITE_DRAIN_MS + 5_000).then(() => "still waiting" as const),
    ]);
    expect(closed).toBe("closed");
    expect(Date.now() - started).toBeLessThan(PGLITE_DRAIN_MS + 2_000);
    // And anything after the close is refused with a sentence.
    const refused = await (async () => handle.db.execute(sql`select 1`))().then(
      () => null,
      (error: unknown) => error,
    );
    // drizzle wraps the driver's error as "Failed query"; the sentence is its cause.
    const cause = refused instanceof Error ? refused.cause : null;
    expect(cause instanceof Error ? cause.message : String(cause)).toContain(
      "the database is closing",
    );
  }, 20_000);
});
