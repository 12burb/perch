import { describe, expect, test } from "bun:test";
import { EMBEDDING_DIMENSIONS, EmbeddingError, embed, fit } from "../src/embeddings.ts";

/**
 * Task 2.17 (ADR-0110). `repo_index.embedding` is one width for everyone, so every vector that
 * reaches it has to be brought to that width the same way, whatever the provider returned. And the
 * key that made the call must not come back in anything a caller, a log, or a retry can see.
 */

const KEY = "sk-test-embed-4f2a";

/** The error a call was supposed to raise, typed, so a test can look inside it. */
async function failure(promise: Promise<unknown>): Promise<EmbeddingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EmbeddingError) return error;
    throw error;
  }
  throw new Error("that call was expected to fail and did not");
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fit", () => {
  test("pads a shorter vector and normalises it", () => {
    const out = fit([3, 4], 8);
    expect(out).toHaveLength(8);
    expect(out[0]).toBeCloseTo(0.6, 10);
    expect(out[1]).toBeCloseTo(0.8, 10);
    expect(out.slice(2)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("folds a longer one rather than truncating it", () => {
    // Everything this vector says is in its tail. Truncating to three would answer with zeros;
    // folding puts the fourth component onto the first, where `3 % 3` lands it.
    const out = fit([0, 0, 0, 4], 3);
    expect(out).toHaveLength(3);
    expect(out[0]).toBeCloseTo(1, 10);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  test("a vector of zeros stays a vector of zeros", () => {
    expect(fit([0, 0, 0], 4)).toEqual([0, 0, 0, 0]);
  });

  test("the default width is the column's", () => {
    expect(fit([1, 2, 3])).toHaveLength(EMBEDDING_DIMENSIONS);
  });
});

describe("embed", () => {
  test("asks for the column's width, sends the key once, and keeps the input order", async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    const vectors = await embed({
      provider: "openai",
      model: "text-embedding-3-small",
      input: ["one", "two"],
      apiKey: KEY,
      fetch: async (url, init) => {
        seen = {
          url,
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: String(init?.body ?? ""),
        };
        // Out of order on purpose: `index` is what says which input each vector is for.
        return respond({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        });
      },
    });
    const call = seen as unknown as { url: string; headers: Record<string, string>; body: string };
    expect(call.url).toEndWith("/embeddings");
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(call.body)).toMatchObject({
      model: "text-embedding-3-small",
      input: ["one", "two"],
      dimensions: EMBEDDING_DIMENSIONS,
    });
    expect(vectors).toHaveLength(2);
    expect(vectors[0]?.[0]).toBeCloseTo(1, 10);
    expect(vectors[1]?.[1]).toBeCloseTo(1, 10);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  test("an endpoint with no key sends no authorization at all", async () => {
    let headers: Record<string, string> = {};
    await embed({
      provider: "ollama",
      model: "embed-test",
      input: ["one"],
      baseUrl: "http://127.0.0.1:11434/v1",
      fetch: async (_url, init) => {
        headers = (init?.headers ?? {}) as Record<string, string>;
        return respond({ data: [{ index: 0, embedding: [1] }] });
      },
    });
    expect(headers.authorization).toBeUndefined();
  });

  test("nothing in asks nothing of the provider", async () => {
    let called = false;
    const out = await embed({
      provider: "openai",
      model: "m",
      input: [],
      apiKey: KEY,
      fetch: async () => {
        called = true;
        return respond({ data: [] });
      },
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test("a refusal says the status and never the key", async () => {
    const error = await failure(
      embed({
        provider: "openai",
        model: "m",
        input: ["one"],
        apiKey: KEY,
        fetch: async () => respond({ error: "nope" }, 401),
      }),
    );
    expect(error.status).toBe(401);
    expect(error.message).not.toContain(KEY);
  });

  test("a provider that cannot be reached says so without repeating the request", async () => {
    const error = await failure(
      embed({
        provider: "openai",
        model: "m",
        input: ["one"],
        apiKey: KEY,
        fetch: async () => {
          throw new Error("connection refused");
        },
      }),
    );
    expect(error.message).toContain("connection refused");
    expect(error.message).not.toContain(KEY);
  });

  test("fewer vectors than inputs is an error, not a short answer", async () => {
    const failed = embed({
      provider: "openai",
      model: "m",
      input: ["one", "two"],
      apiKey: KEY,
      fetch: async () => respond({ data: [{ index: 0, embedding: [1] }] }),
    });
    await expect(failed).rejects.toThrow(/asked .* for 2 embeddings and got 1/);
  });

  test("a body with no data at all is an error", async () => {
    const failed = embed({
      provider: "openai",
      model: "m",
      input: ["one"],
      apiKey: KEY,
      fetch: async () => respond({ ok: true }),
    });
    await expect(failed).rejects.toThrow("that provider answered no embeddings");
  });
});
