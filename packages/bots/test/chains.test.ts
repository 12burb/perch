import { describe, expect, test } from "bun:test";
import {
  botHops,
  type ChainState,
  DEFAULT_MAX_HOPS,
  type Hop,
  mayHop,
  spent,
  summarize,
} from "../src/chains.ts";

/**
 * Task 2.7 (spec §5.4 "Rails: hop limit per root request (default 6), no self-mention, repeat-pair
 * detection (A→B→A→B trips the breaker), per-thread token/dollar budget inherited from the root").
 */

const A = "8f2c0a3e-0000-4000-8000-00000000000a";
const B = "8f2c0a3e-0000-4000-8000-00000000000b";
const C = "8f2c0a3e-0000-4000-8000-00000000000c";
const HUMAN = "8f2c0a3e-0000-4000-8000-000000000001";

function hop(
  fromId: string,
  toBotId: string,
  costUsd = 0.001,
  fromType: Hop["fromType"] = "bot",
): Hop {
  return { fromType, fromId, toBotId, mode: "consult", costUsd };
}

function state(hops: Hop[], budgetUsd: number | null = null, maxHops?: number): ChainState {
  return { hops, budgetUsd, ...(maxHops === undefined ? {} : { maxHops }) };
}

describe("chain rails (task 2.7)", () => {
  test("a person tagging a bot is not a hop, and the first bot-to-bot one is", () => {
    const started = state([hop(HUMAN, A, 0.002, "user")]);
    expect(botHops(started)).toHaveLength(0);
    const verdict = mayHop(started, { fromType: "bot", fromId: A, toBotId: B });
    expect(verdict).toMatchObject({ ok: true, hop: 2 });
  });

  test("a bot never answers itself", () => {
    const verdict = mayHop(state([]), { fromType: "bot", fromId: A, toBotId: A });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.kind).toBe("self");
  });

  test("a chain goes six hops by default, and as far as the spec of the bot that started it says", () => {
    const six = state(
      Array.from({ length: DEFAULT_MAX_HOPS }, (_, i) => hop(i % 2 ? A : B, i % 2 ? C : A)),
    );
    const stopped = mayHop(six, { fromType: "bot", fromId: A, toBotId: C });
    expect(stopped.ok).toBe(false);
    if (!stopped.ok) {
      expect(stopped.kind).toBe("hops");
      expect(stopped.reason).toContain("6");
    }
    // Five is still fine, and a bot that asks for two gets two.
    expect(mayHop(state(six.hops.slice(0, 5)), { fromType: "bot", fromId: A, toBotId: C }).ok).toBe(
      true,
    );
    const short = state([hop(A, B), hop(B, C)], null, 2);
    expect(mayHop(short, { fromType: "bot", fromId: C, toBotId: A }).ok).toBe(false);
  });

  test("A → B → A → B trips the breaker, and A → B → C does not", () => {
    const pingPong = state([hop(A, B), hop(B, A)]);
    const tripped = mayHop(pingPong, { fromType: "bot", fromId: A, toBotId: B });
    expect(tripped.ok).toBe(false);
    if (!tripped.ok) expect(tripped.kind).toBe("repeat");

    // The same pair twice in the same direction is not a bounce, and a third bot breaks it up.
    expect(
      mayHop(state([hop(A, B), hop(A, B)]), { fromType: "bot", fromId: A, toBotId: B }).ok,
    ).toBe(true);
    expect(mayHop(pingPong, { fromType: "bot", fromId: A, toBotId: C }).ok).toBe(true);
    expect(
      mayHop(state([hop(A, B), hop(B, C)]), { fromType: "bot", fromId: C, toBotId: A }).ok,
    ).toBe(true);
    // A person can always say something again, whatever the bots have been doing.
    expect(mayHop(pingPong, { fromType: "user", fromId: HUMAN, toBotId: B }).ok).toBe(true);
  });

  test("the budget is the conversation's, and what is left is said", () => {
    const half = state([hop(HUMAN, A, 0.4, "user"), hop(A, B, 0.3)], 1);
    const verdict = mayHop(half, { fromType: "bot", fromId: B, toBotId: C });
    expect(verdict).toMatchObject({ ok: true, spentUsd: 0.7 });
    if (verdict.ok) expect(verdict.leftUsd).toBeCloseTo(0.3, 9);

    const gone = mayHop(state([hop(A, B, 1.2)], 1), { fromType: "bot", fromId: B, toBotId: C });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.kind).toBe("budget");

    // No budget is not a budget of nothing.
    expect(
      mayHop(state([hop(A, B, 99)], null), { fromType: "bot", fromId: B, toBotId: C }).ok,
    ).toBe(true);
    expect(spent(state([hop(A, B, 0.25), hop(B, C, 0.25)]))).toBeCloseTo(0.5, 9);
  });

  test("the header says who is in it, how far it went, and what it cost", () => {
    const summary = summarize(state([hop(HUMAN, A, 0.002, "user"), hop(A, B, 0.003)]));
    expect(summary.hops).toBe(2);
    expect(summary.bots.sort()).toEqual([A, B].sort());
    expect(summary.costUsd).toBeCloseTo(0.005, 9);
    expect(summary.broken).toBeNull();
    expect(summarize(state([]), "these two have been going back and forth").broken).toContain(
      "back and forth",
    );
  });
});
