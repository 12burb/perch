import { describe, expect, test } from "bun:test";
import { PerchBot, PerchBotError } from "../src/index.ts";

/**
 * The SDK's reading of an answer (spec §7.3). A bot runs behind whatever is in front of Perch, and
 * what is in front of Perch answers in HTML when it is the one refusing; the SDK must say so with
 * the status, never fall over inside its own parsing.
 */

function botAnswering(answer: () => Response): PerchBot {
  return new PerchBot({
    url: "https://perch.example",
    token: "pbot_test",
    fetch: (() => Promise.resolve(answer())) as unknown as typeof fetch,
  });
}

async function failure(bot: PerchBot): Promise<PerchBotError> {
  try {
    await bot.chat.postMessage({ channel: "general", text: "hello" });
  } catch (error) {
    if (error instanceof PerchBotError) return error;
    throw error;
  }
  throw new Error("the call did not fail");
}

describe("what the SDK makes of an answer", () => {
  test("a JSON error is the error Perch sent, with its status", async () => {
    const error = await failure(
      botAnswering(
        () =>
          new Response(
            JSON.stringify({
              error: { code: "forbidden", message: "no", details: { scope: "x" } },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    expect(error.status).toBe(403);
    expect(error.code).toBe("forbidden");
    expect(error.message).toBe("no");
    expect(error.details).toEqual({ scope: "x" });
  });

  test("a body that is not JSON is an error carrying the status, not a crash in the parser", async () => {
    const error = await failure(
      botAnswering(
        () =>
          new Response("<html><body>502 Bad Gateway</body></html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    expect(error.status).toBe(502);
    expect(error.code).toBe("bad_response");
    expect(error.message).toContain("502");
    expect(error.details).toEqual({ body: "<html><body>502 Bad Gateway</body></html>" });
  });

  test("an OK status with a body that is not an object is not an answer either", async () => {
    for (const body of ["<html></html>", "[1, 2]", "null", '"text"']) {
      const error = await failure(botAnswering(() => new Response(body, { status: 200 })));
      expect(error.status, body).toBe(200);
      expect(error.code, body).toBe("bad_response");
    }
  });

  test("an empty body is an empty answer, and a 429 still carries its wait", async () => {
    const error = await failure(
      botAnswering(() => new Response("", { status: 429, headers: { "retry-after": "7" } })),
    );
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe(7);
  });
});

/** A WebSocket that does what the test says, when it says. */
class FakeSocket {
  static last: FakeSocket | null = null;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  closed: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(code?: number, reason?: string): void {
    this.closed = { ...(code === undefined ? {} : { code }), ...(reason ? { reason } : {}) };
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  say(frame: { type: string; payload?: unknown }): void {
    this.emit("message", {
      data: JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", payload: {}, ...frame }),
    });
  }
}

function socketBot(options: Partial<ConstructorParameters<typeof PerchBot>[0]> = {}): PerchBot {
  return new PerchBot({
    url: "https://perch.example",
    token: "pbot_test",
    webSocket: FakeSocket as unknown as typeof WebSocket,
    ...options,
  });
}

describe("socket mode, when things go wrong", () => {
  test("a handler that throws is reported, and the handlers after it still run", async () => {
    const reported: unknown[] = [];
    const unhandled: unknown[] = [];
    const onRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const bot = socketBot({ onError: (error) => reported.push(error) });
      const heard: string[] = [];
      bot.on("app_mention", async () => {
        throw new Error("rate limited");
      });
      bot.on<{ text: string }>("app_mention", (payload) => {
        heard.push(payload.text);
      });
      const connected = bot.connect();
      FakeSocket.last?.say({ type: "hello" });
      await connected;
      FakeSocket.last?.say({ type: "app_mention", payload: { text: "hi" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(heard).toEqual(["hi"]);
      expect(reported).toHaveLength(1);
      expect((reported[0] as Error).message).toBe("rate limited");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  test("a socket refused before hello says why, with its code", async () => {
    const bot = socketBot();
    const connected = bot.connect();
    FakeSocket.last?.emit("close", { code: 1008, reason: "a valid bot token is required" });
    const error = (await connected.then(
      () => null,
      (caught: unknown) => caught,
    )) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("1008");
    expect(error.message).toContain("a valid bot token is required");
  });

  test("a socket that drops after hello is reported, so the bot can connect again", async () => {
    const closes: { code: number; reason: string; requested: boolean }[] = [];
    const bot = socketBot({ onClose: (info) => closes.push(info) });
    const connected = bot.connect();
    FakeSocket.last?.say({ type: "hello" });
    await connected;
    FakeSocket.last?.emit("close", { code: 1001, reason: "api shutting down" });
    expect(closes).toEqual([{ code: 1001, reason: "api shutting down", requested: false }]);
    expect(bot.connected).toBe(false);
  });
});
