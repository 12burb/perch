import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.7 (spec §5.4 "Bots tagging bots"): the chain and its rails. The acceptance is here — three
 * bots complete a fan-out, and a pair that keeps answering each other trips the breaker, which
 * pauses the thread and asks a person what to do.
 *
 * The model is the same stub OpenAI-compatible endpoint the 2.6 test uses, answering per bot, so
 * what a bot "decides" to say is fixed and the rails are what is under test.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let model: ReturnType<typeof Bun.serve> | null = null;
let modelUrl = "";
let ws = "";
let channel = "";
let robin = { cookie: "", id: "" };
/** What each bot says when it is asked, by handle. */
const SAYS = new Map<string, string>();

beforeAll(async () => {
  model = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "stub-1" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("no", { status: 404 });
      const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
      const system = body.messages.find((one) => one.role === "system");
      const handle = /writing @([a-z0-9_-]+)/.exec(String(system?.content ?? ""))?.[1] ?? "";
      const reply = SAYS.get(handle) ?? "Nothing to add.";
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "stub-1",
            choices: [{ index: 0, delta: { content: reply }, finish_reason: null }],
          });
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "stub-1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          });
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  modelUrl = `http://127.0.0.1:${model.port}/v1`;
  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  model?.stop(true);
});

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, cookie: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

async function signUp(name: string, email: string) {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  const cookie = cookiesFrom(res);
  const me = (await call("/api/me", cookie)) as { body: { id: string } };
  return { cookie, id: me.body.id };
}

type MessageBody = {
  id: string;
  author_type: string;
  author_name: string | null;
  thread_root_id: string | null;
  blocks: { type: string; text?: string; id?: string; action?: string }[];
};
type Chain = {
  hops: { hop: number; from_type: string; to_name: string | null; mode: string }[];
  cost_usd: number;
  stopped: boolean;
  breaker: string | null;
};

const say = (text: string, threadRootId?: string) =>
  call(`/api/workspaces/${ws}/channels/${channel}/messages`, robin.cookie, {
    method: "POST",
    json: { text, ...(threadRootId ? { thread_root_id: threadRootId } : {}) },
  }) as Promise<{ status: number; body: MessageBody }>;

const thread = async (rootId: string) => {
  const res = (await call(`/api/workspaces/${ws}/messages/${rootId}/thread`, robin.cookie)) as {
    body: { messages: MessageBody[] };
  };
  return res.body.messages;
};

const chain = async (rootId: string) =>
  ((await call(`/api/workspaces/${ws}/messages/${rootId}/chain`, robin.cookie)) as { body: Chain })
    .body;

async function makeBot(handle: string, name: string, extra: Record<string, unknown> = {}) {
  const made = (await call(`/api/workspaces/${ws}/bots`, robin.cookie, {
    method: "POST",
    json: {
      handle,
      name,
      visibility: "workspace",
      budget: { dailyUsd: 5, ...(extra.budget as object) },
      spec: {
        persona: `You are ${name}.`,
        brain: { profile: "Stub brain" },
        triggers: [{ on: "mention" }],
        tools: [],
        ...(extra.spec as object),
      },
    },
  })) as { status: number; body: { id: string } };
  expect(made.status).toBe(201);
  const installed = await call(`/api/workspaces/${ws}/bots/${made.body.id}/install`, robin.cookie, {
    method: "POST",
    json: { channel_id: channel },
  });
  expect(installed.status).toBe(200);
  return made.body.id;
}

describe("bots tagging bots (task 2.7)", () => {
  test("a workspace with a brain and four bots", async () => {
    const stamp = Date.now();
    robin = await signUp("Robin", `robin-chain-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", robin.cookie, {
      method: "POST",
      json: { name: "Chain Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const created = (await call(`/api/workspaces/${ws}/channels`, robin.cookie, {
      method: "POST",
      json: { type: "public", name: "newsroom" },
    })) as { body: { id: string } };
    channel = created.body.id;

    const credential = (await call(`/api/workspaces/${ws}/credentials`, robin.cookie, {
      method: "POST",
      json: {
        provider: "custom",
        kind: "endpoint",
        scope: "workspace",
        label: "Stub",
        base_url: modelUrl,
      },
    })) as { body: { id: string } };
    expect(
      (
        await call(`/api/workspaces/${ws}/model-profiles`, robin.cookie, {
          method: "POST",
          json: {
            name: "Stub brain",
            provider: "custom",
            model_id: "gpt-4o-mini",
            credential_id: credential.body.id,
            default_for: "chat",
          },
        })
      ).status,
    ).toBe(201);

    await makeBot("lead", "Lead");
    await makeBot("gamma", "Gamma");
    await makeBot("delta", "Delta");
    await makeBot("ping", "Ping");
    await makeBot("pong", "Pong");
  }, 60_000);

  test("three bots complete a fan-out: the lead tags two, both answer, and every hop is on the chain", async () => {
    SAYS.set("lead", "Asking the desk: <@gamma> <@delta> what do you have?");
    SAYS.set("gamma", "Gamma has the crypto piece.");
    SAYS.set("delta", "Delta has the gaming piece.");

    const asked = await say("<@lead> put together today's headlines");
    expect(asked.status).toBe(201);
    await booted.bots.settled();

    const said = await thread(asked.body.id);
    const bots = said.filter((row) => row.author_type === "bot");
    const names = bots.map((row) => row.author_name).sort();
    expect(names).toEqual(["Delta", "Gamma", "Lead"]);
    expect(said.some((row) => row.blocks[0]?.text?.includes("crypto piece"))).toBe(true);
    expect(said.some((row) => row.blocks[0]?.text?.includes("gaming piece"))).toBe(true);

    // Every hop is audited: the person's tag, then the lead's two.
    const view = await chain(asked.body.id);
    expect(view.hops).toHaveLength(3);
    expect(view.hops[0]).toMatchObject({ hop: 1, from_type: "user", to_name: "Lead" });
    expect(
      view.hops
        .slice(1)
        .map((hop) => hop.to_name)
        .sort(),
    ).toEqual(["Delta", "Gamma"]);
    expect(view.hops.every((hop) => hop.from_type !== "system")).toBe(true);
    expect(view.cost_usd).toBeGreaterThan(0);
    expect(view.stopped).toBe(false);
    expect(view.breaker).toBeNull();
  }, 120_000);

  test("a ping-pong pair trips the breaker: the thread pauses and asks a person", async () => {
    SAYS.set("ping", "<@pong> your turn");
    SAYS.set("pong", "<@ping> no, yours");

    const asked = await say("<@ping> start the argument");
    await booted.bots.settled();

    const view = await chain(asked.body.id);
    expect(view.stopped).toBe(true);
    expect(view.breaker).toContain("back and forth");
    // Three hops happened — the person's, ping→pong, pong→ping — and the fourth was refused.
    expect(view.hops).toHaveLength(3);

    const said = await thread(asked.body.id);
    const card = said.find((row) =>
      row.blocks.some(
        (block) => block.type === "approve_deny" && block.action === "chain.intervene",
      ),
    );
    expect(card).toBeDefined();
    expect(card?.blocks[0]?.text).toContain("paused");

    // Nothing more happens while it is paused, however loudly anybody talks.
    const before = (await thread(asked.body.id)).length;
    await say("<@ping> carry on then", asked.body.id);
    await booted.bots.settled();
    expect((await thread(asked.body.id)).length).toBe(before + 1);

    // Continue on the card lets them go on again — the card is answered like any other block.
    const block = card?.blocks.find((one) => one.type === "approve_deny");
    expect(block?.id).toBeDefined();
    const answered = await call(
      `/api/workspaces/${ws}/messages/${card?.id}/interactions`,
      robin.cookie,
      { method: "POST", json: { block_id: block?.id, values: { decision: "approved" } } },
    );
    expect(answered.status).toBe(200);
    await booted.bots.settled();
    expect((await chain(asked.body.id)).stopped).toBe(false);

    // And with the argument settled, they answer again.
    SAYS.set("ping", "Ping is calm now.");
    await say("<@ping> anything to add?", asked.body.id);
    await booted.bots.settled();
    expect(
      (await thread(asked.body.id)).some((row) => row.blocks[0]?.text?.includes("calm now")),
    ).toBe(true);
  }, 120_000);

  test("a thread spends what the bot that started it was given, and Continue grants another go", async () => {
    // A tight thread budget: the lead's first answer alone is more than it may spend.
    const mean = (await call(`/api/workspaces/${ws}/bots`, robin.cookie)) as {
      body: { bots: { id: string; handle: string }[] };
    };
    const leadId = mean.body.bots.find((row) => row.handle === "lead")?.id ?? "";
    expect(
      (
        await call(`/api/workspaces/${ws}/bots/${leadId}`, robin.cookie, {
          method: "PATCH",
          json: { budget: { dailyUsd: 5, perThreadUsd: 0.000001 } },
        })
      ).status,
    ).toBe(200);

    SAYS.set("lead", "<@gamma> over to you");
    SAYS.set("gamma", "Gamma should never get this far.");
    const asked = await say("<@lead> one more time");
    await booted.bots.settled();

    // The lead answered, and its tag was refused because the thread had spent what it had.
    const view = await chain(asked.body.id);
    expect(view.stopped).toBe(true);
    expect(view.breaker).toContain("budget");
    expect(view.hops).toHaveLength(1);
    expect(
      (await thread(asked.body.id)).some((row) =>
        row.blocks[0]?.text?.includes("never get this far"),
      ),
    ).toBe(false);

    // Continue is a person saying it may spend that much again.
    const card = (await thread(asked.body.id)).find((row) =>
      row.blocks.some((block) => block.action === "chain.intervene"),
    );
    const block = card?.blocks.find((one) => one.type === "approve_deny");
    expect(
      (
        await call(`/api/workspaces/${ws}/messages/${card?.id}/interactions`, robin.cookie, {
          method: "POST",
          json: { block_id: block?.id, values: { decision: "approved" } },
        })
      ).status,
    ).toBe(200);
    await booted.bots.settled();
    expect((await chain(asked.body.id)).stopped).toBe(false);

    // Put it back for the tests that follow.
    await call(`/api/workspaces/${ws}/bots/${leadId}`, robin.cookie, {
      method: "PATCH",
      json: { budget: { dailyUsd: 5 } },
    });
  }, 120_000);

  test("Continue lets them go on, and /stop halts a thread outright", async () => {
    const started = (await thread((await say("<@lead> and again")).body.id))[0];
    expect(started).toBeDefined();
    await booted.bots.settled();

    // A person can halt a thread whenever they like.
    const rootId = started?.id ?? "";
    await say("/stop", rootId);
    await booted.bots.settled();
    expect((await chain(rootId)).stopped).toBe(true);

    const quiet = (await thread(rootId)).length;
    await say("<@gamma> anything?", rootId);
    await booted.bots.settled();
    expect((await thread(rootId)).length).toBe(quiet + 1);

    // And let them carry on again.
    await say("/resume", rootId);
    await booted.bots.settled();
    expect((await chain(rootId)).stopped).toBe(false);
    SAYS.set("gamma", "Gamma is back.");
    await say("<@gamma> and now?", rootId);
    await booted.bots.settled();
    expect(
      (await thread(rootId)).some((row) => row.blocks[0]?.text?.includes("Gamma is back")),
    ).toBe(true);
  }, 120_000);
});
