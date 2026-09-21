import { describe, expect, test } from "bun:test";
import { WAKE_MEMORY_LIMIT, WakeMemory } from "../src/services/wake-memory.ts";

/** ADR-0168: the background service's memory of what it woke a phone about is bounded. */
describe("the wake memory", () => {
  test("one state is one wake: a card rewritten in the same state does not wake again", () => {
    const memory = new WakeMemory();
    expect(memory.note("s1", "needs_you")).toBe(true);
    expect(memory.note("s1", "needs_you")).toBe(false);
    expect(memory.note("s1", "failed")).toBe(true);
    expect(memory.note("s1", "needs_you")).toBe(true);
    expect(memory.size).toBe(1);
  });

  test("past the limit the oldest session is forgotten, and an active one stays young", () => {
    const memory = new WakeMemory(3);
    memory.note("a", "needs_you");
    memory.note("b", "needs_you");
    memory.note("c", "needs_you");
    // `a` changes state: it is now the youngest, so `b` is the one to go when `d` arrives.
    memory.note("a", "failed");
    memory.note("d", "needs_you");
    expect(memory.size).toBe(3);
    // `b` was forgotten: its next wake in the same state is news again.
    expect(memory.note("b", "needs_you")).toBe(true);
    // `a` was kept: the same state is not news.
    expect(memory.note("a", "failed")).toBe(false);
  });

  test("the default limit is ten thousand sessions", () => {
    const memory = new WakeMemory();
    for (let i = 0; i < WAKE_MEMORY_LIMIT + 5; i++) memory.note(`s${i}`, "done");
    expect(memory.size).toBe(WAKE_MEMORY_LIMIT);
  });
});
