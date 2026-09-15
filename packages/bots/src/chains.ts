/**
 * The rails on bots tagging bots (spec §5.4; task 2.7).
 *
 * A mention is the collaboration primitive, which is what makes it dangerous: two bots that answer
 * each other will do it forever, and each turn costs money. So every hop is counted, the pair that
 * keeps bouncing is stopped, and a conversation spends what the bot that started it was given and
 * no more.
 *
 * All of it is arithmetic over the hops that have already happened, so the rule a chain is held to
 * can be read here rather than inferred from what a database did.
 */
import type { ChainMode } from "@perch/db";

/** Spec §5.4: "hop limit per root request (default 6)". */
export const DEFAULT_MAX_HOPS = 6;

/** One hop that has already happened. */
export type Hop = {
  fromType: "user" | "bot" | "system";
  fromId: string;
  toBotId: string;
  mode: ChainMode;
  costUsd: number;
};

export type ChainState = {
  /** Every hop of this thread so far, oldest first. */
  hops: Hop[];
  /** What the whole conversation may spend, from the bot that started it; null is uncapped. */
  budgetUsd: number | null;
  maxHops?: number;
};

export type BreakerKind = "self" | "hops" | "repeat" | "budget";
export type ChainVerdict =
  | { ok: true; hop: number; spentUsd: number; leftUsd: number | null }
  | { ok: false; kind: BreakerKind; reason: string };

/** What a chain has cost so far. */
export function spent(state: ChainState): number {
  return state.hops.reduce((total, hop) => total + hop.costUsd, 0);
}

/** The bot-to-bot hops, which are the ones the limit counts: a person tagging a bot is not one. */
export function botHops(state: ChainState): Hop[] {
  return state.hops.filter((hop) => hop.fromType === "bot");
}

function samePair(a: { fromId: string; toBotId: string }, b: { fromId: string; toBotId: string }) {
  return (
    (a.fromId === b.fromId && a.toBotId === b.toBotId) ||
    (a.fromId === b.toBotId && a.toBotId === b.fromId)
  );
}

/**
 * Whether this hop may happen. The reasons are the spec's rails, in the order that matters: a bot
 * never tags itself, a chain goes only so far, a pair that has already bounced twice does not get a
 * third, and nothing runs on a budget that is gone.
 */
export function mayHop(
  state: ChainState,
  next: { fromType: "user" | "bot" | "system"; fromId: string; toBotId: string },
): ChainVerdict {
  if (next.fromId === next.toBotId) {
    return { ok: false, kind: "self", reason: "a bot does not answer itself" };
  }
  const hops = botHops(state);
  const max = state.maxHops ?? DEFAULT_MAX_HOPS;
  if (next.fromType === "bot" && hops.length >= max) {
    return {
      ok: false,
      kind: "hops",
      reason: `this chain has taken its ${max} hops`,
    };
  }
  // A → B → A → B: the last two hops were between these two, and this would be the third.
  const last = hops.slice(-2);
  if (
    next.fromType === "bot" &&
    last.length === 2 &&
    last.every((hop) => samePair(hop, next)) &&
    last[0]?.fromId !== last[1]?.fromId
  ) {
    return {
      ok: false,
      kind: "repeat",
      reason: "these two have been going back and forth",
    };
  }
  const already = spent(state);
  if (state.budgetUsd !== null && already >= state.budgetUsd) {
    return {
      ok: false,
      kind: "budget",
      reason: "this conversation has spent its budget",
    };
  }
  return {
    ok: true,
    hop: state.hops.length + 1,
    spentUsd: already,
    leftUsd: state.budgetUsd === null ? null : Math.max(state.budgetUsd - already, 0),
  };
}

/** What the thread's header says: who is in it, how far it has gone, what it has cost. */
export type ChainSummary = {
  hops: number;
  bots: string[];
  costUsd: number;
  broken: string | null;
};

export function summarize(state: ChainState, breakerReason: string | null = null): ChainSummary {
  const bots = new Set<string>();
  for (const hop of state.hops) {
    if (hop.fromType === "bot") bots.add(hop.fromId);
    bots.add(hop.toBotId);
  }
  return {
    hops: state.hops.length,
    bots: [...bots],
    costUsd: Math.round(spent(state) * 1e6) / 1e6,
    broken: breakerReason,
  };
}
