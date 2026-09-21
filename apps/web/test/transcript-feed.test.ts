import { describe, expect, test } from "bun:test";
import { type FeedRow, TranscriptFeed } from "../src/code/transcript-feed.ts";

/**
 * ADR-0167: the session pane's feed, and what it does when the pane switches sessions while a
 * replay is still on its way.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const text = (seq: number, delta: string): FeedRow => ({ seq, event: { type: "text", delta } });

/** A feed over a fetch that answers when the test says so, one answer per session. */
function feedWithPending() {
  const calls: { sessionId: string; after: number }[] = [];
  const pending = new Map<string, ReturnType<typeof deferred<FeedRow[]>>>();
  let seen: FeedRow[] = [];
  const feed = new TranscriptFeed(
    (sessionId, after) => {
      calls.push({ sessionId, after });
      const answer = deferred<FeedRow[]>();
      pending.set(sessionId, answer);
      return answer.promise;
    },
    (records) => {
      seen = records;
    },
  );
  return { feed, calls, pending, seen: () => seen };
}

describe("the transcript feed", () => {
  test("a replay in flight when the pane switches lands nowhere, and the new session's replay still runs", async () => {
    const { feed, calls, pending, seen } = feedWithPending();
    feed.switchTo("a");
    const first = feed.catchUp();
    feed.switchTo("b");
    const second = feed.catchUp();
    // Both replays were asked for: b's was not skipped because a's was still running.
    expect(calls).toEqual([
      { sessionId: "a", after: 0 },
      { sessionId: "b", after: 0 },
    ]);
    pending.get("b")?.resolve([text(1, "b1")]);
    await second;
    pending.get("a")?.resolve([text(1, "a1"), text(2, "a2"), text(3, "a3")]);
    await first;
    expect(seen()).toEqual([text(1, "b1")]);
    expect(feed.seq).toBe(1);
    // The next delta follows on from b's seq, not a's.
    feed.delta(2, "b2");
    expect(seen().map((row) => row.seq)).toEqual([1, 2]);
  });

  test("a late answer for the old session does not clear the new session's in-flight mark", async () => {
    const { feed, pending } = feedWithPending();
    feed.switchTo("a");
    const first = feed.catchUp();
    feed.switchTo("b");
    const second = feed.catchUp();
    pending.get("a")?.resolve([]);
    await first;
    // b's replay is still running, so asking again joins it rather than starting another.
    expect(feed.catchUp()).toBe(second);
    pending.get("b")?.resolve([]);
    await second;
  });

  test("one catch-up at a time: a second ask while one runs joins it", async () => {
    const { feed, calls, pending } = feedWithPending();
    feed.switchTo("a");
    const one = feed.catchUp();
    const two = feed.catchUp();
    expect(two).toBe(one);
    expect(calls).toHaveLength(1);
    pending.get("a")?.resolve([text(1, "hi")]);
    await one;
    // And once it is done, the next ask starts a new one, after the seq it reached.
    void feed.catchUp();
    expect(calls).toEqual([
      { sessionId: "a", after: 0 },
      { sessionId: "a", after: 1 },
    ]);
  });

  test("a delta in order is appended without a round trip; out of order, it asks for a catch-up", async () => {
    const { feed, calls, pending, seen } = feedWithPending();
    feed.switchTo("a");
    feed.delta(1, "one");
    expect(calls).toHaveLength(0);
    expect(seen()).toEqual([text(1, "one")]);
    feed.delta(3, "three");
    expect(calls).toEqual([{ sessionId: "a", after: 1 }]);
    pending.get("a")?.resolve([text(2, "two"), text(3, "three")]);
    await feed.catchUp();
    expect(seen().map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(feed.seq).toBe(3);
  });

  test("rows already known are not repeated, and what arrives late sorts into place", async () => {
    const { feed, pending, seen } = feedWithPending();
    feed.switchTo("a");
    feed.delta(1, "one");
    feed.delta(2, "two");
    const run = feed.catchUp();
    pending.get("a")?.resolve([text(4, "four"), text(2, "two"), text(3, "three")]);
    await run;
    expect(seen().map((row) => row.seq)).toEqual([1, 2, 3, 4]);
  });

  test("a switch drops the records, and the rows of the old session never come back", async () => {
    const { feed, pending, seen } = feedWithPending();
    feed.switchTo("a");
    feed.delta(1, "one");
    expect(seen()).toHaveLength(1);
    feed.switchTo("b");
    expect(seen()).toEqual([]);
    expect(feed.seq).toBe(0);
    const run = feed.catchUp();
    pending.get("b")?.resolve([]);
    await run;
    expect(seen()).toEqual([]);
  });
});
