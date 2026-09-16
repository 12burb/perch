import { describe, expect, test } from "bun:test";
import { CODE_BOT_LIMITS, prepare, runCodeBot } from "../src/sandbox.ts";

/**
 * Task 3.2 (spec §5.3, §9.3): a code bot runs in QuickJS with a ceiling and no host. What it may do
 * is what its tools allow; what it may not do is everything else.
 */

const MENTION = { kind: "message" as const, payload: { text: "hello", channel: "c1" } };

describe("a code bot", () => {
  test("answers an event with the tools it was given", async () => {
    const posted: unknown[] = [];
    const run = await runCodeBot({
      code: `export default bot({
        async onMessage(event, perch) {
          perch.log("heard", event.text);
          await perch.chat_post({ channel: event.channel, text: "noted: " + event.text });
          return { said: true };
        },
      });`,
      event: MENTION,
      tools: {
        chat_post: async (args) => {
          posted.push(args);
          return { ok: true };
        },
      },
    });
    expect(run.error).toBeNull();
    expect(run.returned).toEqual({ said: true });
    expect(posted).toEqual([{ channel: "c1", text: "noted: hello" }]);
    expect(run.logs).toEqual(["heard hello"]);
    expect(run.calls).toEqual([{ name: "chat_post", ok: true }]);
  });

  test("sees no host at all", async () => {
    const run = await runCodeBot({
      code: `export default bot({
        onMessage: () => [
          typeof fetch, typeof process, typeof require, typeof Bun,
          typeof XMLHttpRequest, typeof setTimeout, typeof globalThis.Deno,
        ].join(","),
      });`,
      event: MENTION,
    });
    expect(run.error).toBeNull();
    expect(run.returned).toBe(
      "undefined,undefined,undefined,undefined,undefined,undefined,undefined",
    );
  });

  test("that loops for ever is stopped by its ceiling", async () => {
    const started = Date.now();
    const run = await runCodeBot({
      code: "export default bot({ onMessage: () => { let i = 0; while (true) i += 1; } });",
      event: MENTION,
      limits: { cpuMs: 150 },
    });
    expect(run.error).toMatch(/interrupt/i);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("that loops after a tool answers is stopped too", async () => {
    const run = await runCodeBot({
      code: `export default bot({
        async onMessage(event, perch) {
          await perch.chat_post({ text: "one" });
          let i = 0;
          while (true) i += 1;
        },
      });`,
      event: MENTION,
      tools: { chat_post: async () => ({ ok: true }) },
      limits: { cpuMs: 150, wallMs: 4_000 },
    });
    expect(run.error).not.toBeNull();
    expect(run.calls).toEqual([{ name: "chat_post", ok: true }]);
  });

  test("that asks for more than it may have is refused, and the run says so", async () => {
    const run = await runCodeBot({
      code: `export default bot({
        async onMessage(event, perch) {
          try {
            await perch.chat_post({ text: "hi" });
            return "posted";
          } catch (error) {
            return "refused: " + error.message;
          }
        },
      });`,
      event: MENTION,
      tools: {},
    });
    // The tool is not on the bot's list, so it is not on `perch` either.
    expect(String(run.returned)).toContain("refused");
  });

  test("cannot call its tools for ever either", async () => {
    const run = await runCodeBot({
      code: `export default bot({
        async onMessage(event, perch) {
          for (let i = 0; i < 100; i += 1) await perch.chat_post({ text: String(i) });
          return "done";
        },
      });`,
      event: MENTION,
      tools: { chat_post: async () => ({ ok: true }) },
      limits: { toolCalls: 5 },
    });
    expect(run.error).not.toBeNull();
    expect(run.calls.filter((one) => one.ok)).toHaveLength(5);
  });

  test("with no handler for the event does nothing, quietly", async () => {
    const run = await runCodeBot({
      code: "export default bot({ onSchedule: () => 'tick' });",
      event: MENTION,
    });
    expect(run.error).toBeNull();
    expect(run.returned).toBeNull();
  });

  test("that throws is a failed run, not a failed api", async () => {
    const run = await runCodeBot({
      code: "export default bot({ onMessage: () => { throw new Error('I refuse'); } });",
      event: MENTION,
    });
    expect(run.error).toContain("I refuse");
  });

  test("that will not parse says so before anything runs", async () => {
    const run = await runCodeBot({ code: "export default bot({", event: MENTION });
    expect(run.error).not.toBeNull();
  });
});

describe("preparing a code bot", () => {
  test("turns the spec's `export default` into something QuickJS can run", () => {
    expect(prepare("export default bot({});")).toBe("globalThis.__bot = bot({});");
    expect(prepare("bot({});")).toBe("bot({});");
  });

  test("refuses an import rather than pretending it worked", () => {
    expect(() => prepare("import { x } from 'y';\nexport default bot({});")).toThrow(/import/);
  });

  test("has a default ceiling that matches the spike", () => {
    expect(CODE_BOT_LIMITS.cpuMs).toBe(200);
  });
});
