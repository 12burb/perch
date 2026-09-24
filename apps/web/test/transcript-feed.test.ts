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

type Page = { rows: FeedRow[]; lastSeq: number };
/** One page of a replay; the session's last seq is the page's last row unless a test says more. */
const page = (rows: FeedRow[], lastSeq = rows.at(-1)?.seq ?? 0): Page => ({ rows, lastSeq });

/** Let pending promise callbacks run until the condition holds (or give up after a while). */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) await Promise.resolve();
  expect(condition()).toBe(true);
}

/** A feed over a fetch that answers when the test says so; the latest ask per session answers. */
function feedWithPending() {
  const calls: { sessionId: string; after: number }[] = [];
  const pending = new Map<string, ReturnType<typeof deferred<Page>>>();
  let seen: FeedRow[] = [];
  const feed = new TranscriptFeed(
    (sessionId, after) => {
      calls.push({ sessionId, after });
      const answer = deferred<Page>();
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
    pending.get("b")?.resolve(page([text(1, "b1")]));
    await second;
    pending.get("a")?.resolve(page([text(1, "a1"), text(2, "a2"), text(3, "a3")]));
    await first;
    expect(seen()).toEqual([text(1, "b1")]);
    expect(feed.seq).toBe(1);
    // The next delta follows on from b's seq, not a's.
    feed.delta(2, "b2");
    expect(seen().map((row) => row.seq)).toEqual([1, 2]);
  });

  test("a late answer for the old session does not clear the new session's in-flight mark", async () => {
    const { feed, calls, pending } = feedWithPending();
    feed.switchTo("a");
    const first = feed.catchUp();
    feed.switchTo("b");
    const second = feed.catchUp();
    pending.get("a")?.resolve(page([]));
    await first;
    // b's replay is still running, so asking again joins it rather than starting another.
    expect(feed.catchUp()).toBe(second);
    pending.get("b")?.resolve(page([]));
    // The ask that joined is answered by one more read once the first one is back.
    await until(() => calls.length === 3);
    expect(calls.at(-1)).toEqual({ sessionId: "b", after: 0 });
    pending.get("b")?.resolve(page([]));
    await second;
  });

  test("one catch-up at a time: a second ask while one runs joins it, and one read follows it", async () => {
    const { feed, calls, pending } = feedWithPending();
    feed.switchTo("a");
    const one = feed.catchUp();
    const two = feed.catchUp();
    const three = feed.catchUp();
    expect(two).toBe(one);
    expect(three).toBe(one);
    expect(calls).toHaveLength(1);
    pending.get("a")?.resolve(page([text(1, "hi")]));
    // The asks that joined are answered by one more read (not one each), after the seq reached.
    await until(() => calls.length === 2);
    pending.get("a")?.resolve(page([]));
    await one;
    expect(calls).toEqual([
      { sessionId: "a", after: 0 },
      { sessionId: "a", after: 1 },
    ]);
    // And once it is done, the next ask starts a new one.
    void feed.catchUp();
    expect(calls).toHaveLength(3);
    pending.get("a")?.resolve(page([]));
  });

  test("a delta in order is appended without a round trip; out of order, it asks for a catch-up", async () => {
    const { feed, calls, pending, seen } = feedWithPending();
    feed.switchTo("a");
    feed.delta(1, "one");
    expect(calls).toHaveLength(0);
    expect(seen()).toEqual([text(1, "one")]);
    feed.delta(3, "three");
    expect(calls).toEqual([{ sessionId: "a", after: 1 }]);
    pending.get("a")?.resolve(page([text(2, "two"), text(3, "three")]));
    await until(() => feed.seq === 3);
    expect(seen().map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(feed.seq).toBe(3);
  });

  test("rows already known are not repeated, and what arrives late sorts into place", async () => {
    const { feed, pending, seen } = feedWithPending();
    feed.switchTo("a");
    feed.delta(1, "one");
    feed.delta(2, "two");
    const run = feed.catchUp();
    pending.get("a")?.resolve(page([text(4, "four"), text(2, "two"), text(3, "three")], 4));
    await run;
    expect(seen().map((row) => row.seq)).toEqual([1, 2, 3, 4]);
  });

  test("a replay longer than one page is fetched page by page until it reaches the session's last seq (A-wc-02)", async () => {
    const calls: number[] = [];
    let seen: FeedRow[] = [];
    const rows = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => text(from + i, "x"));
    const feed = new TranscriptFeed(
      async (_sessionId, after) => {
        calls.push(after);
        return after === 0
          ? { rows: rows(1, 1000), lastSeq: 1500 }
          : { rows: rows(after + 1, 1500), lastSeq: 1500 };
      },
      (records) => {
        seen = records;
      },
    );
    feed.switchTo("a");
    await feed.catchUp();
    expect(calls).toEqual([0, 1000]);
    expect(seen).toHaveLength(1500);
    expect(feed.seq).toBe(1500);
  });

  test("a catch-up asked for while one runs is not lost: one more follows from the new seq (A-wc-03)", async () => {
    const calls: number[] = [];
    const answers: ReturnType<typeof deferred<{ rows: FeedRow[]; lastSeq: number }>>[] = [];
    let seen: FeedRow[] = [];
    const feed = new TranscriptFeed(
      (_sessionId, after) => {
        calls.push(after);
        const answer = deferred<{ rows: FeedRow[]; lastSeq: number }>();
        answers.push(answer);
        return answer.promise;
      },
      (records) => {
        seen = records;
      },
    );
    feed.switchTo("a");
    const first = feed.catchUp();
    // The permission's envelope arrives while the first read is on its way; its row may have been
    // committed after that read, so the ask must not be folded into it.
    const second = feed.catchUp();
    expect(second).toBe(first);
    answers[0]?.resolve({ rows: [text(1, "tool call")], lastSeq: 1 });
    await until(() => calls.length === 2);
    expect(calls).toEqual([0, 1]);
    answers[1]?.resolve({ rows: [text(2, "permission")], lastSeq: 2 });
    await first;
    expect(seen.map((row) => row.seq)).toEqual([1, 2]);
    // Nothing more was asked for, so nothing more is fetched.
    expect(calls).toHaveLength(2);
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
    pending.get("b")?.resolve(page([]));
    await run;
    expect(seen()).toEqual([]);
  });
});
