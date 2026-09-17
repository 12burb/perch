import { describe, expect, test } from "bun:test";
import { RAIL_MODES, railStep } from "../src/shell/rail.tsx";

/**
 * Moving between the modes from the keyboard (task 4.11).
 *
 * The rail is a tablist with a roving tabindex, which means Tab reaches exactly one of its six
 * tabs. Everything else is arrows, Home and End — so what they do is worth a test of its own,
 * separate from the browser that presses them.
 */
describe("the rail's arrow keys (task 4.11)", () => {
  test("down and up walk the modes, and wrap", () => {
    expect(railStep("ArrowDown", "home")).toBe("code");
    expect(railStep("ArrowUp", "code")).toBe("home");
    expect(railStep("ArrowDown", "search")).toBe("home");
    expect(railStep("ArrowUp", "home")).toBe("search");
  });

  test("Home and End go to the ends", () => {
    expect(railStep("Home", "bots")).toBe("home");
    expect(railStep("End", "home")).toBe("search");
  });

  test("every mode is reachable from every other, and only by a key that means to move", () => {
    for (const { mode } of RAIL_MODES) {
      const seen = new Set([mode]);
      let at = mode;
      for (let i = 0; i < RAIL_MODES.length; i += 1) {
        at = railStep("ArrowDown", at) ?? at;
        seen.add(at);
      }
      expect(seen.size).toBe(RAIL_MODES.length);
      expect(railStep("Enter", mode)).toBeNull();
      expect(railStep("a", mode)).toBeNull();
      expect(railStep("ArrowRight", mode)).toBeNull();
    }
  });
});
