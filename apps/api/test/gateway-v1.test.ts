import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@perch/db";
import { eq } from "drizzle-orm";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 4.1 (spec §3.4, §7.4): the model gateway at `/v1`.
 *
 * The acceptance is the third test: an OpenAI client pointed at a Perch virtual key completes a
 * streamed chat through a workspace credential, and a revoked key is refused. Everything else here
 * is what makes that safe to leave open — the key is the only way in, the ledger gets a row, the
 * budget is checked before a provider is called, and a fallback answers when the first will not.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let cookie = "";
let ws = "";
let key = "";
let provider: ReturnType<typeof Bun.serve> | null = null;
let providerUrl = "";
let broken: ReturnType<typeof Bun.serve> | null = null;
let brokenUrl = "";
/** What the stand-in was asked, so a test can prove what went out. */
const asked: string[] = [];
const reply = "Twigs, then moss.";

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((one) => one.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as never };
}

/** A call to `/v1`, the way a client library makes one. */
async function v1(path: string, init: { token?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.json === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(init.token === "" ? {} : { authorization: `Bearer ${init.token ?? key}` }),
    },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  return res;
}

beforeAll(async () => {
  // An OpenAI-compatible provider, which is what a workspace credential points at.
  provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "stub-1" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("no", { status: 404 });
      const body = (await request.json()) as {
        messages: { role: string; content: unknown }[];
        stream?: boolean;
      };
      asked.push(JSON.stringify(body.messages));
      if (!body.stream) {
        return Response.json({
          id: "1",
          object: "chat.completion",
          created: 1,
          model: "stub-1",
          choices: [
            { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        });
      }
      const chunks = reply.match(/.{1,8}/g) ?? [""];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          for (const delta of chunks) {
            send({
              id: "1",
              object: "chat.completion.chunk",
              created: 1,
              model: "stub-1",
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            });
          }
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "stub-1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
          });
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  providerUrl = `http://127.0.0.1:${provider.port}/v1`;

  // And one that is having a bad day, so a fallback has something to fall back from.
  broken = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({ error: "down" }), { status: 503 }),
  });
  brokenUrl = `http://127.0.0.1:${broken.port}/v1`;

  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  const signed = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      name: "Wren",
      email: "wren-gateway@perch.test",
      password: "correct horse battery staple",
    }),
  });
  expect(signed.status).toBe(200);
  cookie = cookiesFrom(signed);
  ws = (
    (await call("/api/workspaces", { method: "POST", json: { name: "Gateway Nest" } })).body as {
      id: string;
    }
  ).id;

  // A workspace credential, which is the point: the key holder never sees it.
  const credential = (await call(`/api/workspaces/${ws}/credentials`, {
    method: "POST",
    json: {
      provider: "custom",
      kind: "endpoint",
      scope: "workspace",
      label: "Stub",
      base_url: providerUrl,
    },
  })) as { status: number; body: { id: string } };
  expect(credential.status).toBe(201);
  const down = (await call(`/api/workspaces/${ws}/credentials`, {
    method: "POST",
    json: {
      provider: "custom",
      kind: "endpoint",
      scope: "workspace",
      label: "Down",
      base_url: brokenUrl,
    },
  })) as { body: { id: string } };

  // Two profiles: the one that works, and one whose provider is down but falls back to it.
  const good = (await call(`/api/workspaces/${ws}/model-profiles`, {
    method: "POST",
    json: {
      name: "chat",
      provider: "custom",
      model_id: "stub-1",
      credential_id: credential.body.id,
      default_for: "chat",
    },
  })) as { status: number; body: { id: string } };
  expect(good.status).toBe(201);
  const flaky = await call(`/api/workspaces/${ws}/model-profiles`, {
    method: "POST",
    json: {
      name: "flaky",
      provider: "custom",
      model_id: "stub-1",
      credential_id: down.body.id,
      fallbacks: ["chat"],
    },
  });
  expect(flaky.status).toBe(201);

  const minted = (await call(`/api/workspaces/${ws}/virtual-keys`, {
    method: "POST",
    json: { name: "A script", subject_type: "external" },
  })) as { status: number; body: { key: string; virtual_key: { prefix: string } } };
  expect(minted.status).toBe(201);
  key = minted.body.key;
}, 60_000);

afterAll(async () => {
  await running?.stop();
  provider?.stop(true);
  broken?.stop(true);
});

describe("the gateway at /v1 (task 4.1)", () => {
  test("a key is the only way in, and it is shown exactly once", async () => {
    // The mint answered with the key; the list never does.
    expect(key.startsWith("pk_")).toBe(true);
    const listed = await call(`/api/workspaces/${ws}/virtual-keys`);
    expect(listed.status).toBe(200);
    const rows = (listed.body as { keys: { prefix: string; subject_type: string }[] }).keys;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject_type).toBe("external");
    expect(listed.text).not.toContain(key);
    expect(key.startsWith(rows[0]?.prefix ?? "nope")).toBe(true);

    // No key, a nonsense key, and a session cookie are all the same answer: not a key.
    expect((await v1("/v1/models", { token: "" })).status).toBe(401);
    expect((await v1("/v1/models", { token: "pk_not-a-key" })).status).toBe(401);
    const withCookie = await fetch(`${base}/v1/models`, { headers: { cookie } });
    expect(withCookie.status).toBe(401);
  }, 60_000);

  test("the models it lists are the profiles the key may name", async () => {
    const res = await v1("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: { id: string; object: string }[] };
    expect(body.object).toBe("list");
    expect(body.data.map((one) => one.id).sort()).toEqual(["chat", "flaky"]);
    expect(body.data[0]?.object).toBe("model");
  }, 60_000);

  test("an OpenAI client streams a chat through a workspace credential, and a revoked key cannot", async () => {
    asked.length = 0;
    const res = await v1("/v1/chat/completions", {
      json: {
        model: "chat",
        stream: true,
        messages: [
          { role: "system", content: "Answer in six words." },
          { role: "user", content: "How do I build a nest?" },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("perch-provider")).toBe("custom");

    // The stream is OpenAI's: `data:` lines of chunks, then `[DONE]`.
    const text = await res.text();
    const lines = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));
    expect(lines.at(-1)).toBe("[DONE]");
    const chunks = lines
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line) as { choices: { delta: { content?: string } }[] });
    expect(chunks[0]?.choices[0]?.delta).toHaveProperty("role", "assistant");
    const said = chunks.map((one) => one.choices[0]?.delta.content ?? "").join("");
    expect(said).toBe(reply);
    // The system prompt went out as a system message, not glued onto the question.
    expect(asked.join("")).toContain("How do I build a nest?");

    // What it cost is in the ledger, against the key that spent it.
    const rows = await booted.db.db
      .select()
      .from(schema.usageEvents)
      .where(eq(schema.usageEvents.workspaceId, ws));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.inputTokens).toBe(120);
    expect(rows[0]?.outputTokens).toBe(30);
    expect(rows[0]?.actorType).toBe("external");

    // And a revoked key is refused, whatever it asks for.
    const listed = (await call(`/api/workspaces/${ws}/virtual-keys`)) as {
      body: { keys: { id: string }[] };
    };
    const id = listed.body.keys[0]?.id ?? "";
    expect(
      (await call(`/api/workspaces/${ws}/virtual-keys/${id}`, { method: "DELETE" })).status,
    ).toBe(204);
    const after = await v1("/v1/chat/completions", {
      json: { model: "chat", messages: [{ role: "user", content: "again?" }] },
    });
    expect(after.status).toBe(401);
    const body = (await after.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_api_key");
  }, 60_000);

  test("a chat that is not streamed says what it cost in the headers", async () => {
    const minted = (await call(`/api/workspaces/${ws}/virtual-keys`, {
      method: "POST",
      json: { name: "Second", subject_type: "external" },
    })) as { body: { key: string } };
    const token = minted.body.key;
    const res = await v1("/v1/chat/completions", {
      token,
      json: { model: "chat", messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toBe(reply);
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage.prompt_tokens).toBe(120);
    expect(res.headers.get("perch-input-tokens")).toBe("120");
    expect(res.headers.get("perch-output-tokens")).toBe("30");
    expect(res.headers.get("perch-cost-usd")).toBe("0.000000");
  }, 60_000);

  test("a model this key may not name is a 404, in OpenAI's words", async () => {
    const minted = (await call(`/api/workspaces/${ws}/virtual-keys`, {
      method: "POST",
      json: { name: "Narrow", subject_type: "external", models: ["chat"] },
    })) as { body: { key: string } };
    const token = minted.body.key;
    // The one it may name works…
    expect(
      (
        await v1("/v1/chat/completions", {
          token,
          json: { model: "chat", messages: [{ role: "user", content: "hi" }] },
        })
      ).status,
    ).toBe(200);
    // …and the workspace's other profile does not exist as far as this key is concerned.
    const res = await v1("/v1/chat/completions", {
      token,
      json: { model: "flaky", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("model_not_found");
    // A model list is narrowed the same way.
    const models = (await (await v1("/v1/models", { token })).json()) as { data: { id: string }[] };
    expect(models.data.map((one) => one.id)).toEqual(["chat"]);
  }, 60_000);

  test("when the first provider will not answer, the chain does", async () => {
    const minted = (await call(`/api/workspaces/${ws}/virtual-keys`, {
      method: "POST",
      json: { name: "Fallback", subject_type: "external" },
    })) as { body: { key: string } };
    const res = await v1("/v1/chat/completions", {
      token: minted.body.key,
      json: { model: "flaky", messages: [{ role: "user", content: "still there?" }] },
    });
    expect(res.status).toBe(200);
    // The answer came from the profile the chain fell through to.
    expect(res.headers.get("perch-provider")).toBe("custom");
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe(reply);
  }, 60_000);

  test("a key that has spent its budget is refused before a provider is called", async () => {
    const minted = (await call(`/api/workspaces/${ws}/virtual-keys`, {
      method: "POST",
      json: {
        name: "Broke",
        subject_type: "external",
        budget: { limit_usd: 0.000001, period: "total" },
      },
    })) as { body: { key: string; virtual_key: { id: string } } };
    const token = minted.body.key;
    // Nothing spent yet: the call goes through and says what is left.
    const first = await v1("/v1/chat/completions", {
      token,
      json: { model: "chat", messages: [{ role: "user", content: "hi" }] },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("perch-budget-remaining")).toBe("0.000001");

    // Spend it: a row on the ledger against this key is what a budget is counted from.
    await booted.db.db.insert(schema.usageEvents).values({
      workspaceId: ws,
      actorType: "external",
      virtualKeyId: minted.body.virtual_key.id,
      provider: "custom",
      modelId: "stub-1",
      inputTokens: 1_000,
      outputTokens: 1_000,
      costUsd: "1.000000",
    });
    const res = await v1("/v1/chat/completions", {
      token,
      json: { model: "chat", messages: [{ role: "user", content: "and again" }] },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("budget_exceeded");
    expect(body.error.type).toBe("insufficient_quota");
    expect(res.headers.get("perch-budget-remaining")).toBe("0");
  }, 60_000);
});
