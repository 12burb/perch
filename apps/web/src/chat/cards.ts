/**
 * What the transcript trusts on a card Perch posts about its own work (ADR-0174). The api refuses
 * these card types from people and Bot API bots, and the transcript still does not take a card's
 * own word for anything it acts on or links into: a race is read back from the api before anybody
 * can pick in it, and an "Open" link is followed only when it stays inside this Perch.
 */
import type { components } from "@perch/api-client";

type Race = components["schemas"]["Race"];

/**
 * An in-app link: a path on this origin, or nothing. A card's "Open" goes to a session or a run in
 * this Perch; anything that would leave it (`https://…`, `//host`, `/\host`, a `javascript:` or
 * `data:` URL) is not drawn as a link at all.
 */
export function internalHref(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith("/")) return null;
  const here = "https://perch.invalid";
  try {
    const resolved = new URL(url, here);
    return resolved.origin === here
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : null;
  } catch {
    return null;
  }
}

export type RaceRow = {
  id: string;
  engine: string;
  state: string;
  additions: number | null;
  deletions: number | null;
  costUsd: number | null;
  checks: number | null;
};

export type RaceView = {
  state: string;
  decidedBy: string | null;
  entrants: RaceRow[];
  /** True when the rows are the api's own; only then is there anything to pick. */
  live: boolean;
};

const numberOr = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The race a card shows. Once the api has answered, the rows are the race's own — engine, state,
 * diff, cost and checks as the race records them — whatever the card says; until then (or when
 * this reader may not see the race) the card's rows are shown to read, with nothing to press.
 */
export function raceView(block: Record<string, unknown>, race: Race | undefined): RaceView {
  if (race) {
    return {
      state: race.state,
      decidedBy: race.decided_by,
      live: true,
      entrants: race.entrants.map((one) => ({
        id: one.id,
        engine: one.engine,
        state: one.state,
        additions: one.additions,
        deletions: one.deletions,
        costUsd: one.cost_usd,
        checks: one.checks_exit_code,
      })),
    };
  }
  const entrants = Array.isArray(block.entrants)
    ? (block.entrants as Record<string, unknown>[])
    : [];
  return {
    state: String(block.state ?? "running"),
    decidedBy: typeof block.decidedBy === "string" ? block.decidedBy : null,
    live: false,
    entrants: entrants.map((one) => ({
      id: String(one.id ?? one.engine ?? ""),
      engine: String(one.engine ?? ""),
      state: String(one.state ?? "running"),
      additions: numberOr(one.additions),
      deletions: numberOr(one.deletions),
      costUsd: numberOr(one.costUsd),
      checks: numberOr(one.checks),
    })),
  };
}

/**
 * Whether an entrant gets a Pick: only on a race the api answered for, still running, on a card
 * the system posted (a race card is never a person's or a bot's), for an entrant that did not fail.
 */
export function canPick(view: RaceView, authorType: string | undefined, entrant: RaceRow): boolean {
  return (
    view.live && authorType === "system" && view.state === "running" && entrant.state !== "failed"
  );
}
