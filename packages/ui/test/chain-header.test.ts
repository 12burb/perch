import { describe, expect, test } from "bun:test";
import { money } from "../src/components/chain-header.tsx";

/** Task 2.7: what a thread's header says a chain has cost. */
describe("money", () => {
  test("cents when there are any, words when there are not", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(-1)).toBe("$0.00");
    expect(money(0.004)).toBe("under a cent");
    expect(money(0.01)).toBe("$0.01");
    expect(money(1.239)).toBe("$1.24");
  });
});
