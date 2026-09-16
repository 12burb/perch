import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 4.2 (spec §10's Phase 4 line, §7.1 `usage?from&to&group_by`): budgets and the ledger the
 * dashboard is drawn from.
 *
 * The acceptance is the last test: a bot that runs out of budget stops and says so in the thread,
 * and the usage endpoint shows the spend by model, by bot and by person.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let cookie = "";
let ws = "";
let me = "";
let channelId = "";
let botId = "";
let provider: ReturnType<typeof Bun.serve> | null = null;

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

type MessageRow = { id: string; author_type: string; blocks: { type: string; text?: string }[] };

/** A bot answers in the thread of what it was asked, so both lists are one conversation. */
async function messages(threadRootId?: string): Promise<MessageRow[]> {
  const path = threadRootId
    ? `/api/workspaces/${ws}/messages/${threadRootId}/thread`
    : `/api/workspaces/${ws}/channels/${channelId}/messages`;
  const res = (await call(path)) as { body: { messages: MessageRow[] } };
  return res.body.messages;
}

async function until<T>(get: () => Promise<T | null>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = await get();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("it never happened");
}

beforeAll(async () => {
  // A provider that answers whatever it is asked, with a price the ledger can add up.
  provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "gpt-4o" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("no", { status: 404 });
      await request.json();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4o",
            choices: [{ index: 0, delta: { content: "On it." }, finish_reason: null }],
          });
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4o",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1_000, completion_tokens: 1_000, total_tokens: 2_000 },
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
  const providerUrl = `http://127.0.0.1:${provider.port}/v1`;

  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  const signed = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      name: "Robin",
      email: "robin-budgets@perch.test",
      password: "correct horse battery staple",
    }),
  });
  expect(signed.status).toBe(200);
  cookie = cookiesFrom(signed);
  me = ((await call("/api/me")).body as { id: string }).id;
  ws = (
    (await call("/api/workspaces", { method: "POST", json: { name: "Budget Nest" } })).body as {
      id: string;
    }
  ).id;
  channelId = (
    (
      await call(`/api/workspaces/${ws}/channels`, {
        method: "POST",
        json: { type: "public", name: "general" },
      })
    ).body as { id: string }
  ).id;

  const credential = (await call(`/api/workspaces/${ws}/credentials`, {
    method: "POST",
    json: {
      provider: "custom",
      kind: "endpoint",
      scope: "workspace",
      label: "Stub",
      base_url: providerUrl,
    },
  })) as { body: { id: string } };
  await call(`/api/workspaces/${ws}/model-profiles`, {
    method: "POST",
    json: {
      name: "chat",
      provider: "custom",
      // A model with a price, so what the bot spends is not zero.
      model_id: "gpt-4o",
      credential_id: credential.body.id,
      default_for: "chat",
    },
  });
  const bot = (await call(`/api/workspaces/${ws}/bots`, {
    method: "POST",
    json: {
      handle: "ada",
      name: "Ada",
      visibility: "workspace",
      spec: {
        persona: "Answer briefly.",
        brain: { profile: "chat" },
        triggers: [{ on: "mention" }],
        tools: [],
      },
    },
  })) as { status: number; body: { id: string } };
  expect(bot.status).toBe(201);
  botId = bot.body.id;
  await call(`/api/workspaces/${ws}/bots/${botId}/install`, {
    method: "POST",
    json: { channel_id: channelId },
  });
}, 60_000);

afterAll(async () => {
  await running?.stop();
  provider?.stop(true);
});

describe("budgets and the ledger (task 4.2)", () => {
  test("a budget is set for the workspace, a person or a bot, and says where it stands", async () => {
    const set = await call(`/api/workspaces/${ws}/budgets`, {
      method: "PUT",
      json: { subject_type: "workspace", limit_usd: 100, period: "month", warn_at: 0.5 },
    });
    expect(set.status).toBe(200);
    expect((set.body as { limit_usd: number; spent_usd: number }).limit_usd).toBe(100);
    expect((set.body as { remaining_usd: number }).remaining_usd).toBe(100);

    // Setting the same subject again moves the ceiling rather than making a second one.
    await call(`/api/workspaces/${ws}/budgets`, {
      method: "PUT",
      json: { subject_type: "workspace", limit_usd: 50, period: "month" },
    });
    const listed = (await call(`/api/workspaces/${ws}/budgets`)) as {
      body: { budgets: { id: string; limit_usd: number; subject_type: string }[] };
    };
    expect(listed.body.budgets).toHaveLength(1);
    expect(listed.body.budgets[0]?.limit_usd).toBe(50);

    // A person's or a bot's budget needs to say whose.
    const missing = await call(`/api/workspaces/${ws}/budgets`, {
      method: "PUT",
      json: { subject_type: "bot", limit_usd: 1 },
    });
    expect(missing.status).toBe(422);

    // And it can be taken away; the ledger keeps what was spent.
    const id = listed.body.budgets[0]?.id ?? "";
    expect((await call(`/api/workspaces/${ws}/budgets/${id}`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect(
      ((await call(`/api/workspaces/${ws}/budgets`)).body as { budgets: unknown[] }).budgets,
    ).toHaveLength(0);
  }, 60_000);

  test("a bot that runs out of budget stops and says so, and the ledger shows what went where", async () => {
    // One answer first, so there is something in the ledger.
    const first = (await call(`/api/workspaces/${ws}/channels/${channelId}/messages`, {
      method: "POST",
      json: { blocks: [{ type: "text", text: "@ada what is the plan?" }] },
    })) as { status: number; body: { id: string } };
    expect(first.status).toBe(201);
    await until(async () => {
      const said = (await messages(first.body.id)).find((one) => one.author_type === "bot");
      return said?.blocks[0]?.text?.includes("On it.") ? said : null;
    });

    // The ledger has it, by model, by actor and by day.
    const byModel = (await call(`/api/workspaces/${ws}/usage?group_by=model`)) as {
      status: number;
      body: { total_usd: number; slices: { key: string; cost_usd: number; calls: number }[] };
    };
    expect(byModel.status).toBe(200);
    expect(byModel.body.slices.map((one) => one.key)).toEqual(["gpt-4o"]);
    // 1000 in and 1000 out of gpt-4o is $0.0025 + $0.01 by the price table.
    expect(byModel.body.total_usd).toBeCloseTo(0.0125, 6);
    const byActor = (await call(`/api/workspaces/${ws}/usage?group_by=actor`)) as {
      body: { slices: { key: string; calls: number }[] };
    };
    expect(byActor.body.slices.map((one) => one.key)).toEqual([botId]);
    const byDay = (await call(`/api/workspaces/${ws}/usage?group_by=day`)) as {
      body: { slices: { key: string }[] };
    };
    expect(byDay.body.slices[0]?.key).toBe(new Date().toISOString().slice(0, 10));

    // Now a ceiling below what it has already spent: the next answer is a refusal, in the channel.
    const set = await call(`/api/workspaces/${ws}/budgets`, {
      method: "PUT",
      json: { subject_type: "bot", subject_id: botId, limit_usd: 0.001, period: "month" },
    });
    expect(set.status).toBe(200);
    expect((set.body as { remaining_usd: number }).remaining_usd).toBeLessThan(0);

    const asked = (await call(`/api/workspaces/${ws}/channels/${channelId}/messages`, {
      method: "POST",
      json: { blocks: [{ type: "text", text: "@ada and now?" }] },
    })) as { body: { id: string } };
    const refusal = await until(async () => {
      const said = (await messages(asked.body.id)).find(
        (one) => one.author_type === "bot" && one.blocks[0]?.text?.includes("budget"),
      );
      return said ?? null;
    });
    expect(refusal.blocks[0]?.text).toContain("has spent its budget");

    // And nothing new went through the provider: the refusal happens before the model is called.
    const after = (await call(`/api/workspaces/${ws}/usage?group_by=model`)) as {
      body: { slices: { calls: number }[] };
    };
    expect(after.body.slices[0]?.calls).toBe(1);

    // A workspace ceiling that is fine leaves the bot alone again.
    const budgets = (await call(`/api/workspaces/${ws}/budgets`)) as {
      body: { budgets: { id: string; subject_type: string }[] };
    };
    const botBudget = budgets.body.budgets.find((one) => one.subject_type === "bot");
    await call(`/api/workspaces/${ws}/budgets/${botBudget?.id}`, { method: "DELETE" });
    await call(`/api/workspaces/${ws}/budgets`, {
      method: "PUT",
      json: { subject_type: "user", subject_id: me, limit_usd: 1_000, period: "day" },
    });
    await call(`/api/workspaces/${ws}/channels/${channelId}/messages`, {
      method: "POST",
      json: { blocks: [{ type: "text", text: "@ada once more?" }] },
    });
    await until(async () => {
      const calls = (
        (await call(`/api/workspaces/${ws}/usage?group_by=model`)).body as {
          slices: { calls: number }[];
        }
      ).slices[0]?.calls;
      return calls === 2 ? calls : null;
    });
  }, 120_000);
});
