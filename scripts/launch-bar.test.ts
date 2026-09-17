import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BAR, check, holds, leg, record, report, within } from "./launch-bar.ts";

/**
 * The launch bar (task 4.13).
 *
 * The bar is a table of numbers, and the thing worth testing is that it cannot pass by accident:
 * a leg nobody measured is not a pass, a leg one millisecond over is a failure, and a typo in a
 * leg's name is an error rather than a silent no-op.
 */

describe("the launch bar (task 4.13)", () => {
  test("every leg says what it times, what it costs, and where it is proved", () => {
    expect(BAR.length).toBeGreaterThan(3);
    for (const one of BAR) {
      expect(one.id, one.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(one.label.length, one.id).toBeGreaterThan(20);
      expect(one.budgetMs, one.id).toBeGreaterThan(1000);
      expect(one.provedBy, one.id).toMatch(/\.(ts|yml)/);
    }
    expect(new Set(BAR.map((one) => one.id)).size).toBe(BAR.length);
  });

  test("the spec's own number is the one on the loop", () => {
    expect(leg("first-agent-pr")?.budgetMs).toBe(10 * 60_000);
  });

  test("a leg nobody measured is not a pass, and not a failure either", () => {
    const results = check({});
    expect(results.every((one) => one.ok === null)).toBe(true);
    expect(holds(results)).toBe(true);
    expect(report(results)).toContain("not measured");
  });

  test("one millisecond over is over", () => {
    const budget = leg("first-agent-pr")?.budgetMs ?? 0;
    expect(holds(check({ "first-agent-pr": budget }))).toBe(true);
    expect(holds(check({ "first-agent-pr": budget + 1 }))).toBe(false);
    expect(report(check({ "first-agent-pr": budget + 1 }))).toContain("OVER");
  });

  test("a number that is not a number is not a measurement", () => {
    expect(check({ "curl-sh": Number.NaN })[1]?.ok).toBeNull();
  });

  test("`within` throws over budget and says the number either way", () => {
    expect(() => within("laptop-boot", 1)).not.toThrow();
    expect(() => within("laptop-boot", 60 * 60_000)).toThrow(/over budget/);
    expect(() => within("not-a-leg", 1)).toThrow(/no such leg/);
  });

  test("records accumulate rather than replace, and a misspelt leg is an error", () => {
    const file = join(mkdtempSync(join(tmpdir(), "perch-bar-")), "launch-bar.json");
    record("curl-sh", 1234.6, file);
    record("laptop-boot", 99, file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      "curl-sh": 1235,
      "laptop-boot": 99,
    });
    expect(() => record("nope", 1, file)).toThrow(/no such leg/);
  });
});
