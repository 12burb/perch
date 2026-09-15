import { describe, expect, test } from "bun:test";
import {
  baseUrlFor,
  CatalogError,
  detectOllama,
  type FetchLike,
  listModels,
  providerInfo,
} from "../src/index.ts";

/**
 * Task 1.15: the catalog is what a provider says it has, asked over the OpenAI-compatible model
 * list, so a key, an aggregator, and a laptop's Ollama all go through one path (ADR-0081).
 */

function server(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; auth: string | null }[] = [];
  const stub: FetchLike = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") });
    return handler(url, init);
  };
  return { stub, calls };
}

const ok = (models: unknown[]) =>
  new Response(JSON.stringify({ object: "list", data: models }), {
    headers: { "content-type": "application/json" },
  });

describe("the model catalog (task 1.15)", () => {
  test("a provider's list becomes the picker's models, sorted, with the key only in the header", async () => {
    const { stub, calls } = server(() =>
      ok([
        { id: "gpt-4o-mini", object: "model", owned_by: "openai" },
        { id: "gpt-4.1", object: "model", owned_by: "openai" },
        { id: 42 },
        "nonsense",
      ]),
    );
    const models = await listModels({ provider: "openai", apiKey: "sk-secret", fetch: stub });
    expect(models).toEqual([
      { id: "gpt-4.1", ownedBy: "openai" },
      { id: "gpt-4o-mini", ownedBy: "openai" },
    ]);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.auth).toBe("Bearer sk-secret");
  });

  test("an endpoint credential brings its own base URL, and needs no key", async () => {
    const { stub, calls } = server(() => ok([{ id: "llama3.2:3b" }]));
    const models = await listModels({
      provider: "ollama",
      baseUrl: "http://nest.local:11434/v1/",
      fetch: stub,
    });
    expect(models).toEqual([{ id: "llama3.2:3b" }]);
    expect(calls[0]?.url).toBe("http://nest.local:11434/v1/models");
    expect(calls[0]?.auth).toBeNull();
    expect(baseUrlFor("custom", "https://gateway.example.com/v1/")).toBe(
      "https://gateway.example.com/v1",
    );
  });

  test("a refusal says what happened without repeating the request", async () => {
    const { stub } = server(
      () => new Response("nope", { status: 401, statusText: "Unauthorized" }),
    );
    await expect(
      listModels({ provider: "openai", apiKey: "sk-secret", fetch: stub }),
    ).rejects.toThrow(/401/);
    const failed = await listModels({ provider: "openai", apiKey: "sk-secret", fetch: stub }).catch(
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(CatalogError);
    expect(String(failed)).not.toContain("sk-secret");

    const { stub: dead } = server(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(
      listModels({ provider: "custom", baseUrl: "http://x/v1", fetch: dead }),
    ).rejects.toThrow(/could not reach/);
    // A provider whose list is not the OpenAI shape says so instead of guessing.
    expect(providerInfo("anthropic")?.lists).toBe(false);
    await expect(listModels({ provider: "anthropic", apiKey: "k", fetch: dead })).rejects.toThrow(
      /does not publish a model list/,
    );
  });

  test("Ollama is found where it answers, and not invented where it does not", async () => {
    const { stub, calls } = server((url) =>
      url.startsWith("http://nest.local")
        ? ok([{ id: "qwen3:8b" }])
        : new Response("", { status: 404 }),
    );
    const found = await detectOllama({
      urls: ["http://nowhere:1/v1", "http://nest.local:11434/v1"],
      fetch: stub,
    });
    expect(found).toEqual({ baseUrl: "http://nest.local:11434/v1", models: [{ id: "qwen3:8b" }] });
    expect(calls.map((c) => c.url)).toEqual([
      "http://nowhere:1/v1/models",
      "http://nest.local:11434/v1/models",
    ]);

    const { stub: none } = server(() => new Response("", { status: 404 }));
    expect(await detectOllama({ urls: [], fetch: none })).toBeNull();
  });
});
