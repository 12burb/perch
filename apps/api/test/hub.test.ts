import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { catalog, hubCounts } from "@perch/hub";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * The Hub (task 4.12).
 *
 * The acceptance is the last test here: a bot installed from the Hub — not made in the Forge, not
 * seeded by the demo — answers when it is spoken to. Everything above it is the index itself and
 * the three other kinds, because an index that lists something it cannot install is worse than no
 * index at all.
 *
 * The model is the same stub OpenAI-compatible endpoint the bot tests use, so what is covered is
 * the whole lane: the Hub's install, the vault, the gateway, and the reply in the thread.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let model: ReturnType<typeof Bun.serve> | null = null;
let modelUrl = "";
let ws = "";
let channel = "";
const robin = { cookie: "", id: "" };
const reply = "Here is what happened today, briefly.";

beforeAll(async () => {
  model = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "stub-1" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("no", { status: 404 });
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
            usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 },
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
    .map((one) => one.split(";")[0] ?? "")
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
  return { status: res.status, body: (text ? JSON.parse(text) : null) as never };
}

type HubItemBody = { kind: string; id: string; name: string; installs: string; tags: string[] };
type HubListBody = { items: HubItemBody[]; counts: Record<string, number> };
type InstallBody = {
  item: HubItemBody;
  installed: boolean;
  detail: string;
  href?: string;
  bot_id?: string;
  project_id?: string;
};
type MessageBody = {
  id: string;
  author_type: string;
  author_id: string;
  blocks: { type: string; text?: string }[];
};

const install = (json: Record<string, unknown>) =>
  call(`/api/workspaces/${ws}/hub/install`, robin.cookie, { method: "POST", json }) as Promise<{
    status: number;
    body: InstallBody;
  }>;

describe("the Hub (task 4.12)", () => {
  test("a workspace, a channel and a brain to answer with", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-hub-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    robin.cookie = cookiesFrom(signUp);
    const made = await call("/api/workspaces", robin.cookie, {
      method: "POST",
      json: { name: "Hub Nest" },
    });
    ws = (made.body as { id: string }).id;
    const created = await call(`/api/workspaces/${ws}/channels`, robin.cookie, {
      method: "POST",
      json: { type: "public", name: "newsroom" },
    });
    channel = (created.body as { id: string }).id;

    const credential = await call(`/api/workspaces/${ws}/credentials`, robin.cookie, {
      method: "POST",
      json: {
        provider: "custom",
        kind: "endpoint",
        scope: "workspace",
        label: "Stub",
        base_url: modelUrl,
      },
    });
    expect(credential.status).toBe(201);
    const profile = await call(`/api/workspaces/${ws}/model-profiles`, robin.cookie, {
      method: "POST",
      json: {
        name: "Stub brain",
        provider: "custom",
        model_id: "stub-1",
        credential_id: (credential.body as { id: string }).id,
        default_for: "chat",
      },
    });
    expect(profile.status).toBe(201);
  }, 60_000);

  test("the index is the whole index, and it filters", async () => {
    const all = (await call("/api/hub", robin.cookie)) as { status: number; body: HubListBody };
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBe(catalog().length);
    expect(all.body.counts).toEqual(hubCounts());

    const bots = (await call("/api/hub?kind=bot", robin.cookie)) as { body: HubListBody };
    expect(bots.body.items.every((one) => one.kind === "bot")).toBe(true);
    // The counts are the index's, not the page's: a filter does not change what there is.
    expect(bots.body.counts).toEqual(hubCounts());

    const found = (await call("/api/hub?q=github", robin.cookie)) as { body: HubListBody };
    expect(found.body.items.some((one) => one.id === "github")).toBe(true);
  });

  test("a stranger does not get the index", async () => {
    const res = await fetch(`${base}/api/hub`);
    expect(res.status).toBe(403);
  });

  test("a connector says where to go rather than pretending to connect", async () => {
    const res = await install({ kind: "connector", id: "github" });
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(false);
    expect(res.body.href).toContain("connect=github");
    expect(res.body.detail).toContain("token");
  });

  test("a template becomes a project", async () => {
    const res = await install({ kind: "template", id: "bun-api", name: "Hub Stack" });
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(true);
    expect(res.body.project_id).toBeTruthy();
    const project = await call(
      `/api/workspaces/${ws}/projects/${res.body.project_id}`,
      robin.cookie,
    );
    expect(project.status).toBe(200);
    expect((project.body as { name: string }).name).toBe("Hub Stack");
  }, 120_000);

  test("something the index does not have is a 404, not an empty install", async () => {
    expect((await install({ kind: "bot", id: "not-a-template" })).status).toBe(404);
  });

  test("a skill needs a bot to go on", async () => {
    const res = await install({ kind: "skill", id: "headline-brief" });
    expect(res.status).toBe(422);
  });

  test("a bot installs from the Hub into the workspace, and answers", async () => {
    const res = await install({ kind: "bot", id: "grok-newsroom", channel });
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(true);
    expect(res.body.item.name).toBe("Grok Newsroom");
    expect(res.body.bot_id).toBeTruthy();
    expect(res.body.detail).toContain("#newsroom");

    // It is in the channel, so a mention reaches it without a second trip through the Forge.
    const question = (await call(
      `/api/workspaces/${ws}/channels/${channel}/messages`,
      robin.cookie,
      {
        method: "POST",
        json: { text: "<@grok> what happened today?" },
      },
    )) as { status: number; body: MessageBody };
    expect(question.status).toBe(201);
    await booted.bots.settled();

    const thread = (await call(
      `/api/workspaces/${ws}/messages/${question.body.id}/thread`,
      robin.cookie,
    )) as { body: { messages: MessageBody[] } };
    const answer = thread.body.messages.find((one) => one.author_type === "bot");
    expect(answer?.author_id).toBe(res.body.bot_id);
    expect(answer?.blocks[0]?.text).toBe(reply);
  }, 120_000);

  test("installing the same bot twice is not a second bot", async () => {
    const again = await install({ kind: "bot", id: "grok-newsroom" });
    expect(again.status).toBe(200);
    expect(again.body.installed).toBe(false);
    expect(again.body.detail).toContain("already");
    const bots = (await call(`/api/workspaces/${ws}/bots`, robin.cookie)) as {
      body: { bots: { handle: string }[] };
    };
    expect(bots.body.bots.filter((one) => one.handle === "grok").length).toBe(1);
  });

  test("a skill goes onto a bot that already exists, and it keeps what it had", async () => {
    const before = (await call(`/api/workspaces/${ws}/bots`, robin.cookie)) as {
      body: { bots: { id: string; handle: string }[] };
    };
    const grok = before.body.bots.find((one) => one.handle === "grok");
    expect(grok).toBeDefined();
    // Grok already carries its own skill, so this one is the interesting case: the same skill
    // arriving twice must not double up.
    const twice = await install({ kind: "skill", id: "headline-brief", bot: "grok" });
    expect(twice.status).toBe(200);
    expect(twice.body.installed).toBe(false);
    const bot = (await call(`/api/workspaces/${ws}/bots/${grok?.id}`, robin.cookie)) as {
      body: { spec: { persona: string; skills?: { name: string }[] } };
    };
    expect(bot.body.spec.skills?.map((one) => one.name)).toEqual(["headline-brief"]);
    expect(bot.body.spec.persona.length).toBeGreaterThan(10);
  });

  test("a skill onto a bot that is not here is a 404", async () => {
    expect((await install({ kind: "skill", id: "headline-brief", bot: "nobody" })).status).toBe(
      404,
    );
  });
});
