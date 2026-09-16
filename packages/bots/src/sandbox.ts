/**
 * Code bots in a QuickJS sandbox (spec §5.3 "code bots `export default bot({ onMessage, onSchedule,
 * onWebhook })` with @perch/bot-sdk in a QuickJS sandbox"; §9.3's ceiling; task 3.2).
 *
 * The bot is a file in a repository and it runs nowhere near the host: no `fetch`, no `process`, no
 * filesystem, no timers it can hide in. What it *can* do is call the tools its spec allows, through
 * the same registry a native bot uses — so a code bot has no permissions a form bot does not, and
 * the allow-list stays the one thing that decides.
 *
 * The shape is ADR-0033's, proven by spike 0.4.5: the sync release build, an interrupt handler for
 * the CPU slice, a memory limit, and host tools as QuickJS promises settled from the host with
 * `executePendingJobs()`, which is what makes `await perch.chat.post(…)` work inside bot code.
 */
import { getQuickJS, type QuickJSContext, type QuickJSRuntime } from "quickjs-emscripten";

/** What one run may take (spec §9.3: "a 200 ms CPU budget"). */
export type CodeBotLimits = {
  /** One uninterrupted slice of JavaScript, reset each time a tool answers. */
  cpuMs: number;
  /** The whole run, tool round trips included. */
  wallMs: number;
  memoryBytes: number;
  stackBytes: number;
  /** How many tool calls one run may make, so a loop of allowed calls is still a loop. */
  toolCalls: number;
  /** How many lines `perch.log` keeps. */
  logs: number;
};

export const CODE_BOT_LIMITS: CodeBotLimits = {
  /** One uninterrupted slice of JavaScript, reset each time a tool answers. */
  cpuMs: 200,
  /** The whole run, tool round trips included. */
  wallMs: 15_000,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  /** How many tool calls one run may make, so a loop of allowed calls is still a loop. */
  toolCalls: 32,
  /** How many lines `perch.log` keeps. */
  logs: 50,
};

/** What set the bot off, handed to the handler as its first argument. */
export type CodeBotEvent =
  | { kind: "message"; payload: Record<string, unknown> }
  | { kind: "schedule"; payload: Record<string, unknown> }
  | { kind: "webhook"; payload: Record<string, unknown> };

const HANDLER: Record<CodeBotEvent["kind"], string> = {
  message: "onMessage",
  schedule: "onSchedule",
  webhook: "onWebhook",
};

export type CodeBotTools = Record<string, (args: unknown) => Promise<unknown>>;

export type CodeBotRun = {
  /** What the handler returned, when it returned something JSON can carry. */
  returned: unknown;
  /** Everything it said with `perch.log`, in order. */
  logs: string[];
  /** Which tools it called, in order — the run's own record of what it did. */
  calls: { name: string; ok: boolean }[];
  /** Why it stopped, when it stopped badly. `null` means it finished. */
  error: string | null;
};

/**
 * `export default bot({…})` is how the spec writes a code bot, and QuickJS has no module system.
 * The rewrite is the whole of the "build step": the default export becomes an assignment, and an
 * `import` is refused rather than silently ignored, because a bot that thinks it imported something
 * is a bot that will fail in a way nobody can read.
 */
export function prepare(code: string): string {
  if (/^\s*import\s/m.test(code)) {
    throw new Error("a code bot cannot import: everything it may use is on `perch`");
  }
  return code.replace(/^\s*export\s+default\s+/m, "globalThis.__bot = ");
}

type Sandbox = { runtime: QuickJSRuntime; ctx: QuickJSContext; dispose: () => void };

/** The preamble the bot is evaluated on top of: `bot()`, `perch`, and nothing else. */
function preamble(tools: readonly string[]): string {
  const sugar = tools
    .map(
      (name) => `  ${JSON.stringify(name)}: (args) => __callJson(${JSON.stringify(name)}, args),`,
    )
    .join("\n");
  return `
globalThis.bot = (handlers) => {
  globalThis.__bot = handlers;
  return handlers;
};
globalThis.perch = {
  log: (...parts) => __log(parts.map((one) => typeof one === "string" ? one : JSON.stringify(one)).join(" ")),
${sugar}
};
`;
}

async function open(input: {
  tools: CodeBotTools;
  limits: CodeBotLimits;
  run: CodeBotRun;
  deadlineAt: number;
  slice: { until: number };
}): Promise<Sandbox> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(input.limits.memoryBytes);
  runtime.setMaxStackSize(input.limits.stackBytes);
  // Two ceilings, and the run stops at whichever comes first: one slice of JavaScript, and the
  // whole run. A tool that takes a second is not the bot spinning; a loop after it is.
  runtime.setInterruptHandler(
    () => Date.now() > input.slice.until || Date.now() > input.deadlineAt,
  );
  const ctx = runtime.newContext();

  const log = ctx.newFunction("__log", (handle) => {
    if (input.run.logs.length < input.limits.logs) input.run.logs.push(ctx.getString(handle));
  });
  ctx.setProp(ctx.global, "__log", log);
  log.dispose();

  const call = ctx.newFunction("__call", (nameHandle, argsHandle) => {
    const name = ctx.getString(nameHandle);
    const raw = ctx.getString(argsHandle);
    const deferred = ctx.newPromise();
    const impl = input.tools[name];
    const over = input.run.calls.length >= input.limits.toolCalls;
    const answer =
      over || !impl
        ? Promise.reject(new Error(over ? "too many tool calls in one run" : `no tool ${name}`))
        : impl(JSON.parse(raw) as unknown);
    void answer.then(
      (result) => {
        input.run.calls.push({ name, ok: true });
        const value = ctx.newString(JSON.stringify(result ?? null));
        deferred.resolve(value);
        value.dispose();
      },
      (error: unknown) => {
        input.run.calls.push({ name, ok: false });
        const thrown = ctx.newError(error instanceof Error ? error.message : String(error));
        deferred.reject(thrown);
        thrown.dispose();
      },
    );
    void deferred.settled.then(() => {
      // The bot gets a fresh slice for what it does with the answer, not the remains of the last
      // one — otherwise a bot that awaits twice trips on the second `await` rather than on a loop.
      input.slice.until = Date.now() + input.limits.cpuMs;
      runtime.executePendingJobs();
    });
    return deferred.handle;
  });
  ctx.setProp(ctx.global, "__call", call);
  call.dispose();

  ctx
    .unwrapResult(
      ctx.evalCode(
        "globalThis.__callJson = (name, args) => __call(name, JSON.stringify(args ?? null)).then(JSON.parse);",
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

/**
 * Runs one event through a code bot. Never throws for anything the bot did: a bot that loops, runs
 * out of memory, or throws comes back with `error` set, because that is a `bot_runs` row and not a
 * reason for the api to fall over.
 */
export async function runCodeBot(input: {
  code: string;
  event: CodeBotEvent;
  tools?: CodeBotTools;
  limits?: Partial<CodeBotLimits>;
}): Promise<CodeBotRun> {
  const limits = { ...CODE_BOT_LIMITS, ...input.limits };
  const run: CodeBotRun = { returned: null, logs: [], calls: [], error: null };
  const tools = input.tools ?? {};
  const deadlineAt = Date.now() + limits.wallMs;
  const slice = { until: Date.now() + limits.cpuMs };

  let prepared: string;
  try {
    prepared = prepare(input.code);
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
    return run;
  }

  let sb: Sandbox | null = null;
  try {
    sb = await open({ tools, limits, run, deadlineAt, slice });
    const ctx = sb.ctx;
    ctx.unwrapResult(ctx.evalCode(preamble(Object.keys(tools)), "perch.js")).dispose();
    ctx.unwrapResult(ctx.evalCode(prepared, "bot.js")).dispose();

    const handler = HANDLER[input.event.kind];
    slice.until = Date.now() + limits.cpuMs;
    const started = ctx.evalCode(
      `(() => {
         const handlers = globalThis.__bot;
         if (!handlers || typeof handlers[${JSON.stringify(handler)}] !== "function") return null;
         return Promise.resolve(handlers[${JSON.stringify(handler)}](${JSON.stringify(input.event.payload)}, globalThis.perch));
       })()`,
      "run.js",
    );
    const handle = ctx.unwrapResult(started);
    const settled = ctx.resolvePromise(handle);
    handle.dispose();
    sb.runtime.executePendingJobs();
    // The wall-clock ceiling has to hold even when the bot is waiting on a tool, where the
    // interrupt handler never fires.
    const value = await Promise.race([
      settled,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("the run took longer than it is allowed to")),
          Math.max(0, deadlineAt - Date.now()),
        ),
      ),
    ]);
    const out = ctx.unwrapResult(value);
    run.returned = ctx.dump(out) as unknown;
    out.dispose();
  } catch (error) {
    run.error = reason(error);
  } finally {
    try {
      sb?.dispose();
    } catch {
      // A runtime that died mid-interrupt cannot always be disposed; the process is not harmed.
    }
  }
  return run;
}

/** What to write in the ledger when a run stops badly, without a QuickJS handle in it. */
function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const shaped = error as { name?: unknown; message?: unknown };
    const name = typeof shaped.name === "string" ? shaped.name : "";
    const message = typeof shaped.message === "string" ? shaped.message : "";
    if (name || message) return `${name}${name && message ? ": " : ""}${message}`;
  }
  return String(error);
}
