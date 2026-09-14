import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@perch/events";
import { EngineError } from "../src/engine.ts";
import { FakeEngine } from "../src/fake.ts";
import { EngineRegistry } from "../src/registry.ts";

/**
 * Task 1.8: the fake engine streams a scripted round, pauses on a permission until it is answered,
 * ends a cancelled round with done, refuses a second concurrent round, and the registry hands out
 * one engine object per id (per runner link for factories).
 */

const params = {
  sessionId: "0190f2d0-0000-7000-8000-0000000000e1",
  workspaceId: "0190f2d0-0000-7000-8000-000000000001",
  projectId: "0190f2d0-0000-7000-8000-0000000000p1",
  userId: "0190f2d0-0000-7000-8000-0000000000aa",
  model: { provider: "openai", modelId: "gpt-5" },
  mode: "build" as const,
};

async function collect(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("the fake engine (task 1.8)", () => {
  test("echoes a turn as text deltas, then usage and done", async () => {
    const engine = new FakeEngine();
    const session = await engine.createSession(params);
    expect(session).toEqual({ id: params.sessionId, engineSessionId: "fake-0190f2d0" });
    const events = await collect(engine.send(params.sessionId, { text: "hello there" }));
    const text = events
      .filter((e): e is Extract<EngineEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("Echo (build): hello there");
    expect(events.at(-2)).toMatchObject({ type: "usage", input: 11 });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(engine.rounds(params.sessionId)).toBe(1);
    // The mode option wins over the session's.
    const plan = await collect(engine.send(params.sessionId, { text: "x" }, { mode: "plan" }));
    expect(plan[0]).toEqual({ type: "text", delta: "Echo" });
    expect(plan[1]).toEqual({ type: "text", delta: " (plan):" });
  });

  test("a permission pauses the round until it is answered; cancel ends a round", async () => {
    const engine = new FakeEngine({
      script: () => [
        { type: "tool_call", id: "c1", name: "fs.write", args: { path: "a.txt" } },
        { type: "permission", id: "p1", tool: "fs.write", args: { path: "a.txt" } },
        { type: "tool_result", id: "c1", output: "ok" },
        { type: "done" },
      ],
    });
    await engine.createSession(params);
    const seen: EngineEvent[] = [];
    const round = (async () => {
      for await (const event of engine.send(params.sessionId, { text: "write" })) seen.push(event);
    })();
    const until = async (n: number) => {
      const deadline = Date.now() + 5_000;
      while (seen.length < n && Date.now() < deadline) await Bun.sleep(5);
    };
    await until(2);
    expect(seen.map((e) => e.type)).toEqual(["tool_call", "permission"]);
    // Nothing moves while the permission waits.
    await Bun.sleep(30);
    expect(seen).toHaveLength(2);
    await expect(engine.respondPermission(params.sessionId, "nope", "allow")).rejects.toThrow(
      /no permission nope/,
    );
    await engine.respondPermission(params.sessionId, "p1", "always");
    await round;
    expect(seen.map((e) => e.type)).toEqual(["tool_call", "permission", "tool_result", "done"]);
    expect(engine.answers(params.sessionId)).toEqual([{ id: "p1", answer: "always" }]);

    // Cancel while a permission waits: the round ends with done, the permission counts as denied.
    const second: EngineEvent[] = [];
    const cancelled = (async () => {
      for await (const event of engine.send(params.sessionId, { text: "again" }))
        second.push(event);
    })();
    const deadline = Date.now() + 5_000;
    while (second.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    await engine.cancel(params.sessionId);
    await cancelled;
    expect(second.map((e) => e.type)).toEqual(["tool_call", "permission", "done"]);
    expect(engine.answers(params.sessionId).at(-1)).toEqual({ id: "p1", answer: "deny" });
  });

  test("one round at a time; unknown sessions are refused; close forgets", async () => {
    const engine = new FakeEngine({ delayMs: 20 });
    await engine.createSession(params);
    const first = collect(engine.send(params.sessionId, { text: "one" }));
    await Bun.sleep(5);
    const busy = engine.send(params.sessionId, { text: "two" })[Symbol.asyncIterator]();
    await expect(busy.next()).rejects.toMatchObject({ code: "busy" });
    await first;
    await expect(collect(engine.send("missing", { text: "x" }))).rejects.toBeInstanceOf(
      EngineError,
    );
    await engine.close(params.sessionId);
    await expect(engine.cancel(params.sessionId)).rejects.toMatchObject({
      code: "unknown_session",
    });
  });

  test("the registry: static engines are shared, factories are memoised per runner link", () => {
    const registry = new EngineRegistry();
    const fake = new FakeEngine();
    let built = 0;
    registry.register("fake", fake).register("acp", () => {
      built += 1;
      return new FakeEngine({ id: "acp" });
    });
    expect(registry.ids()).toEqual(["fake", "acp"]);
    expect(registry.resolve("fake")).toBe(fake);
    const link = { id: "r1" } as never;
    const a = registry.resolve("acp", { link });
    expect(registry.resolve("acp", { link })).toBe(a);
    expect(registry.resolve("acp", { link: { id: "r2" } as never })).not.toBe(a);
    expect(built).toBe(2);
    expect(() => registry.resolve("nope")).toThrow(/unknown engine nope/);
    expect(registry.has("nope")).toBe(false);
  });
});
