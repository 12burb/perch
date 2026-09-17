import { describe, expect, test } from "bun:test";
import {
  chaosDrill,
  DRILLS,
  loadDrill,
  percentile,
  report,
  TARGETS,
  upgradeDrill,
} from "./reliability.ts";

/**
 * The reliability bar (task 4.10).
 *
 * `bun run reliability` runs the published bar — a hundred sessions. This runs the same drills at a
 * size the gate can afford, so a change that breaks the upgrade path, leaves a session running
 * after its runner dies, or stops a wave of sessions from answering fails `bun run check` rather
 * than a nightly somebody reads next week.
 */

const SESSIONS = 12;

describe("the reliability bar (task 4.10)", () => {
  test("the targets are numbers, and every drill is named", () => {
    for (const [name, value] of Object.entries(TARGETS)) {
      expect(typeof value, name).toBe("number");
      expect(value, name).toBeGreaterThan(0);
    }
    expect(Object.keys(DRILLS).sort()).toEqual(["chaos", "load", "upgrade"]);
  });

  test("a percentile is the nearest rank, and an empty sample is zero", () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 95)).toBe(10);
    expect(percentile(ten, 100)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBe(0);
    // Out of order in, sorted out.
    expect(percentile([9, 1, 5], 50)).toBe(5);
  });

  test("a wave of sessions all open and all answer", async () => {
    const rows = await loadDrill({ sessions: SESSIONS });
    expect(report(rows)).toContain("ok");
    expect(rows.filter((row) => !row.ok).map((row) => `${row.name}: ${row.measured}`)).toEqual([]);
    const answered = rows.find((row) => row.name.startsWith("sessions that opened"));
    expect(answered?.measured).toBe(`${SESSIONS}/${SESSIONS}`);
  }, 300_000);

  test("an older schema upgrades with its rows, and a backup restores into an empty database", async () => {
    const rows = await upgradeDrill();
    expect(rows.filter((row) => !row.ok).map((row) => `${row.name}: ${row.measured}`)).toEqual([]);
    expect(rows.length).toBe(3);
  }, 300_000);

  test("a runner killed mid-turn leaves nothing running", async () => {
    const rows = await chaosDrill();
    expect(rows.filter((row) => !row.ok).map((row) => `${row.name}: ${row.measured}`)).toEqual([]);
    // The point of the drill: it was running, and then it was not.
    expect(rows[0]?.measured).toBe("running");
    expect(rows[1]?.measured).toMatch(/^(error|idle|ended)\b/);
  }, 300_000);
});
