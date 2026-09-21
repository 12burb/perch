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
