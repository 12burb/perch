import { describe, expect, test } from "bun:test";
import { canPick, internalHref, raceView } from "../src/chat/cards.ts";

/**
 * ADR-0174 (A-wr-06): what the transcript takes from a card Perch posts about its own work. A race
 * card's rows and its Pick come from the race the api has, and an "Open" link is drawn only when
 * it stays inside this Perch.
 */

const raceId = "01900000-0000-7000-8000-000000000001";
const good = "01900000-0000-7000-8000-00000000000a";
const bad = "01900000-0000-7000-8000-00000000000b";

/** The race as the api records it: `bad` failed its checks, `good` passed them. */
const race = {
  id: raceId,
  project_id: "01900000-0000-7000-8000-000000000002",
  work_item_id: null,
  prompt: "edit the banner",
  state: "running" as const,
  decided_by: null,
  winner_id: null,
  created_at: "2026-09-24T00:00:00.000Z",
  entrants: [
    {
      id: good,
      session_id: null,
      engine: "acp",
      agent: null,
      branch: "race/acp",
      state: "finished" as const,
      cost_usd: 0.1,
      files_changed: 1,
      additions: 3,
      deletions: 1,
      checks_exit_code: 0,
      detail: null,
    },
    {
      id: bad,
      session_id: null,
      engine: "opencode",
      agent: null,
      branch: "race/opencode",
      state: "finished" as const,
      cost_usd: 0.2,
      files_changed: 4,
      additions: 40,
      deletions: 2,
      checks_exit_code: 1,
      detail: null,
    },
  ],
};

/** A card that names the real race but swaps what it says about the two entrants. */
const swapped = {
  type: "race_card",
  raceId,
  state: "running",
  entrants: [
    { id: bad, engine: "acp", branch: "race/acp", state: "finished", checks: 0 },
    { id: good, engine: "opencode", branch: "race/opencode", state: "failed", checks: 1 },
  ],
};

describe("race cards (A-wr-06)", () => {
  test("the rows are the race's own once the api answers, whatever the card says", () => {
    const view = raceView(swapped, race);
    expect(view.live).toBe(true);
    expect(view.entrants.map((one) => [one.id, one.engine, one.checks])).toEqual([
      [good, "acp", 0],
      [bad, "opencode", 1],
    ]);
  });

  test("Pick is offered only on a live race, on a card the system posted", () => {
    const live = raceView(swapped, race);
    const first = live.entrants[0];
    if (!first) throw new Error("no entrant");
    expect(canPick(live, "system", first)).toBe(true);
    // A person's or a bot's message is never a race card anybody picks from.
    expect(canPick(live, "user", first)).toBe(false);
    expect(canPick(live, "bot", first)).toBe(false);
    // Before the api answers — or for a reader who may not see the race — the card is read-only.
    const offline = raceView(swapped, undefined);
    const shown = offline.entrants[0];
    if (!shown) throw new Error("no entrant");
    expect(offline.live).toBe(false);
    expect(canPick(offline, "system", shown)).toBe(false);
    // A decided race has nothing left to pick.
    const decided = raceView(swapped, { ...race, state: "decided" });
    expect(decided.entrants.some((one) => canPick(decided, "system", one))).toBe(false);
  });
});

describe("in-app links (A-wr-06)", () => {
  test("a path on this origin is a link", () => {
    expect(internalHref("/nest/code/p1?session=s1")).toBe("/nest/code/p1?session=s1");
    expect(internalHref("/nest/home/c1#m1")).toBe("/nest/home/c1#m1");
  });

  test("anything that would leave this Perch is not", () => {
    for (const url of [
      "https://elsewhere.test/login",
      "//elsewhere.test/login",
      "/\\elsewhere.test/login",
      "javascript:void(0)",
      "data:text/html,hi",
      "nest/code/p1",
      "",
      42,
      undefined,
    ]) {
      expect(internalHref(url)).toBeNull();
    }
  });
});
