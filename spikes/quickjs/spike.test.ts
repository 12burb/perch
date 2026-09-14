import { describe, expect, test } from "bun:test";
import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSRuntime,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten";

/**
 * Spike 0.4.5 — QuickJS sandbox (spec §9.3).
 * Pass: a code bot runs with a 200 ms CPU budget, no host access, and a tool call round trip.
 *
 * Host tools are exposed the way quickjs-emscripten documents for asynchronous host functions: the host
 * function returns a QuickJS promise (`ctx.newPromise()`), settles it when the host work finishes, and drives
 * the job queue (`runtime.executePendingJobs()`). The asyncify build was tried first and is not used: on Bun
 * 1.3.11 its runtime disposal fails with "QuickJSRuntime not found when trying to free HostRef" (ADR-0033).
 */

type Sandbox = { runtime: QuickJSRuntime; ctx: QuickJSContext; dispose: () => void };

async function sandbox(opts: {
  cpuBudgetMs: number;
  memoryLimitBytes?: number;
  tools?: Record<string, (args: unknown) => Promise<unknown>>;
}): Promise<Sandbox> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(opts.memoryLimitBytes ?? 64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + opts.cpuBudgetMs));
  const ctx = runtime.newContext();

  const tools = opts.tools ?? {};
  const toolFn = ctx.newFunction("__tool", (nameHandle, argsHandle) => {
    const name = ctx.getString(nameHandle);
    const args = JSON.parse(ctx.getString(argsHandle)) as unknown;
    const deferred = ctx.newPromise();
    const impl = tools[name];
    (impl ? impl(args) : Promise.reject(new Error(`unknown tool ${name}`))).then(
      (result) => {
        const value = ctx.newString(JSON.stringify(result ?? null));
        deferred.resolve(value);
        value.dispose();
      },
      (err: unknown) => {
        const error = ctx.newError(String(err));
        deferred.reject(error);
        error.dispose();
      },
    );
    // Once the promise settles on the host side, let the bot's continuation run.
    deferred.settled.then(() => runtime.executePendingJobs());
    return deferred.handle;
  });
  ctx.setProp(ctx.global, "__tool", toolFn);
  toolFn.dispose();
  ctx
    .unwrapResult(
      ctx.evalCode(
        "globalThis.tool = (name, args) => __tool(name, JSON.stringify(args ?? null)).then(JSON.parse);",
      ),
    )
    .dispose();

  return {
    runtime,
    ctx,
    dispose: () => {
      ctx.dispose();
      runtime.dispose();
    },
  };
}

/** Evaluates bot code that returns a promise, drives the job queue, and returns the settled value. */
async function runBot(sb: Sandbox, code: string): Promise<unknown> {
  const handle = sb.ctx.unwrapResult(sb.ctx.evalCode(code, "bot.js"));
  const settled = sb.ctx.resolvePromise(handle);
  handle.dispose();
  sb.runtime.executePendingJobs();
  const value = sb.ctx.unwrapResult(await settled);
  const out = sb.ctx.dump(value) as unknown;
  value.dispose();
  return out;
}

describe("spike 0.4.5 QuickJS sandbox", () => {
  test("an infinite loop is interrupted by the 200 ms CPU budget", async () => {
    const sb = await sandbox({ cpuBudgetMs: 200 });
    const started = performance.now();
    const result = sb.ctx.evalCode("let i = 0; while (true) { i++; }");
    const elapsed = performance.now() - started;
    expect(result.error).toBeDefined();
    if (result.error) {
      const err = sb.ctx.dump(result.error) as { name?: string; message?: string };
      result.error.dispose();
      expect(`${err.name} ${err.message}`).toMatch(/interrupt/i);
    }
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
    sb.dispose();
  });

  test("the bot sees no host: no fetch, process, require, Bun, or XMLHttpRequest", async () => {
    const sb = await sandbox({ cpuBudgetMs: 1_000 });
    const out = sb.ctx.unwrapResult(
      sb.ctx.evalCode(
        '[typeof fetch, typeof process, typeof require, typeof Bun, typeof globalThis.Deno, typeof XMLHttpRequest].join(",")',
      ),
    );
    expect(sb.ctx.getString(out)).toBe(
      "undefined,undefined,undefined,undefined,undefined,undefined",
    );
    out.dispose();
    sb.dispose();
  });

  test("a tool round trip crosses the boundary and back", async () => {
    const calls: unknown[] = [];
    const sb = await sandbox({
      cpuBudgetMs: 5_000,
      tools: {
        chat_post: async (args) => {
          calls.push(args);
          await new Promise((r) => setTimeout(r, 5));
          return { ok: true, message_id: "m1" };
        },
      },
    });
    const out = await runBot(
      sb,
      `(async () => {
         const r = await tool("chat_post", { channel: "general", text: "hi from the sandbox" });
         return { posted: r.ok, id: r.message_id };
       })()`,
    );
    expect(out).toEqual({ posted: true, id: "m1" });
    expect(calls).toEqual([{ channel: "general", text: "hi from the sandbox" }]);
    sb.dispose();
  });

  test("a tool failure surfaces as a rejection inside the bot", async () => {
    const sb = await sandbox({ cpuBudgetMs: 5_000, tools: {} });
    const out = await runBot(
      sb,
      `(async () => { try { await tool("missing", {}); return "no error"; } catch (e) { return String(e); } })()`,
    );
    expect(String(out)).toContain("unknown tool missing");
    sb.dispose();
  });

  test("the memory limit is enforced", async () => {
    const sb = await sandbox({ cpuBudgetMs: 3_000, memoryLimitBytes: 4 * 1024 * 1024 });
    const started = performance.now();
    const result = sb.ctx.evalCode(
      'const a = []; try { for (let i = 0; i < 1e6; i++) a.push({ i, s: "y".repeat(64) }); "no error" } catch (e) { String(e) }',
    );
    const elapsed = performance.now() - started;
    const out = sb.ctx.dump(sb.ctx.unwrapResult(result)) as string;
    expect(out).toMatch(/out of memory/i);
    expect(elapsed).toBeLessThan(2_000);
    const big = sb.ctx.evalCode('"x".repeat(64 * 1024 * 1024)');
    expect(big.error).toBeDefined();
    big.error?.dispose();
    sb.dispose();
  });
});
