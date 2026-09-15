import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.9 (spec §5.2 "DM-a-bot: New chat starts a fresh thread; model picker per DM when the bot
 * allows"). The acceptance is here: a chat with a bot is a room of its own, every chat in it is a
 * thread, a new one starts the bot on nothing, and the person can put it on another brain.
 *
 * The model is the same stub endpoint the rest of the bot tests use — what it was shown is what
 * proves the context, so the stub keeps every messages array it was sent.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let model: ReturnType<typeof Bun.serve> | null = null;
let modelUrl = "";
let ws = "";
let robin = { cookie: "", id: "" };
const asked: { model: string; messages: string }[] = [];
let reply = "I am here.";

beforeAll(async () => {
  model = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "stub-1" }, { id: "stub-2" }] });
      }
      if (!url.pathname.endsWith("/chat/completions")) return new Response("no", { status: 404 });
      const body = (await request.json()) as {
        model: string;
        messages: { role: string; content: unknown }[];
      };
      asked.push({ model: body.model, messages: JSON.stringify(body.messages) });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: { content: reply }, finish_reason: null }],
          });
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
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

type Dm = { channel_id: string; brain: string | null; can_pick_brain: boolean };
type MessageBody = {
  id: string;
  author_type: string;
  author_id: string;
  thread_root_id: string | null;
  blocks: { type: string; text?: string }[];
};
type RunBody = { id: string; trigger: string; status: string; model_id: string | null };

describe("a chat with a bot (task 2.9)", () => {
  let botId = "";
  let plain = "";
  let dm = "";

  const say = (text: string, threadRootId?: string) =>
    call(`/api/workspaces/${ws}/channels/${dm}/messages`, robin.cookie, {
      method: "POST",
      json: { text, ...(threadRootId ? { thread_root_id: threadRootId } : {}) },
    }) as Promise<{ status: number; body: MessageBody }>;

  const chat = async (rootId: string) => {
    const res = (await call(`/api/workspaces/${ws}/messages/${rootId}/thread`, robin.cookie)) as {
      body: { messages: MessageBody[] };
    };
    return res.body.messages;
  };

  const runs = async () => {
    const res = (await call(`/api/workspaces/${ws}/bots/${botId}/runs`, robin.cookie)) as {
      body: { runs: RunBody[] };
    };
    return res.body.runs;
  };

  test("a bot with two brains to choose from", async () => {
    const stamp = Date.now();
    robin = await signUp("Robin", `robin-dm-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", robin.cookie, {
      method: "POST",
      json: { name: "Chat Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;

    const credential = (await call(`/api/workspaces/${ws}/credentials`, robin.cookie, {
      method: "POST",
      json: {
        provider: "custom",
        kind: "endpoint",
        scope: "workspace",
        label: "Stub",
        base_url: modelUrl,
      },
    })) as { status: number; body: { id: string } };
    expect(credential.status).toBe(201);
    for (const [name, modelId, fallback] of [
      ["Everyday", "stub-1", "chat"],
      ["The big one", "stub-2", null],
    ] as const) {
      const profile = await call(`/api/workspaces/${ws}/model-profiles`, robin.cookie, {
        method: "POST",
        json: {
          name,
          provider: "custom",
          model_id: modelId,
          credential_id: credential.body.id,
          ...(fallback ? { default_for: fallback } : {}),
        },
      });
      expect(profile.status).toBe(201);
    }

    const bot = (await call(`/api/workspaces/${ws}/bots`, robin.cookie, {
      method: "POST",
      json: {
        handle: "ada",
        name: "Ada",
        visibility: "workspace",
        spec: {
          persona: "You answer questions in a chat of your own.",
          brain: { profile: "Everyday", pick: true },
          triggers: [{ on: "dm" }],
          tools: [],
        },
        budget: { dailyUsd: 5 },
      },
    })) as { status: number; body: { id: string } };
    expect(bot.status).toBe(201);
    botId = bot.body.id;

    const other = (await call(`/api/workspaces/${ws}/bots`, robin.cookie, {
      method: "POST",
      json: {
        handle: "grace",
        name: "Grace",
        visibility: "workspace",
        spec: { brain: { profile: "Everyday" }, triggers: [{ on: "dm" }] },
      },
    })) as { body: { id: string } };
    plain = other.body.id;
  }, 60_000);

  test("opening the chat makes one room, and opening it again finds the same one", async () => {
    const opened = (await call(`/api/workspaces/${ws}/bots/${botId}/dm`, robin.cookie, {
      method: "POST",
    })) as { status: number; body: Dm };
    expect(opened.status).toBe(200);
    expect(opened.body.can_pick_brain).toBe(true);
    expect(opened.body.brain).toBeNull();
    dm = opened.body.channel_id;

    const again = (await call(`/api/workspaces/${ws}/bots/${botId}/dm`, robin.cookie, {
      method: "POST",
    })) as { body: Dm };
    expect(again.body.channel_id).toBe(dm);

    // It is a DM, it is the person's own, and the bot is in it.
    const channels = (await call(`/api/workspaces/${ws}/channels`, robin.cookie)) as {
      body: { channels: { id: string; type: string; name: string | null; member: boolean }[] };
    };
    const room = channels.body.channels.find((row) => row.id === dm);
    expect(room).toMatchObject({ type: "dm", name: null, member: true });
    const members = (await call(`/api/workspaces/${ws}/channels/${dm}/members`, robin.cookie)) as {
      body: { members: { member_type: string; member_id: string }[] };
    };
    expect(members.body.members).toHaveLength(2);
    expect(members.body.members.some((m) => m.member_type === "bot" && m.member_id === botId)).toBe(
      true,
    );
  }, 60_000);

  test("every chat is a thread, and a new one starts the bot on nothing", async () => {
    asked.length = 0;
    reply = "Friday, as agreed.";
    const first = await say("when are we deploying?");
    expect(first.status).toBe(201);
    expect(first.body.thread_root_id).toBeNull();
    await booted.bots.settled();

    // The answer hangs off the message that started the chat, so the chat is the thread.
    const opening = await chat(first.body.id);
    const answer = opening.find((row) => row.author_type === "bot");
    expect(answer?.thread_root_id).toBe(first.body.id);
    expect(answer?.blocks[0]?.text).toBe("Friday, as agreed.");

    // Saying more in the same chat is a reply in it, and the bot can see what came before.
    reply = "The one we just said.";
    const more = await say("which deploy?", first.body.id);
    expect(more.body.thread_root_id).toBe(first.body.id);
    await booted.bots.settled();
    expect(asked[1]?.messages).toContain("when are we deploying?");
    expect(asked[1]?.messages).toContain("Friday, as agreed.");

    // "New chat" is a new root, and the bot starts on nothing but what is said in it.
    reply = "I have no idea what you mean.";
    const fresh = await say("and what about that?");
    expect(fresh.body.thread_root_id).toBeNull();
    await booted.bots.settled();
    expect(asked[2]?.messages).toContain("and what about that?");
    expect(asked[2]?.messages).not.toContain("when are we deploying?");

    // The chats stay apart: the flow of the room is one message per chat.
    const flow = (await call(`/api/workspaces/${ws}/channels/${dm}/messages`, robin.cookie)) as {
      body: { messages: MessageBody[] };
    };
    expect(flow.body.messages.map((row) => row.blocks[0]?.text)).toEqual([
      "when are we deploying?",
      "and what about that?",
    ]);
  }, 60_000);

  test("the person picks the brain, and the bot runs on it", async () => {
    // Everything so far has run on the brain the bot was made with.
    expect((await runs()).every((row) => row.model_id === "stub-1")).toBe(true);

    const picked = (await call(`/api/workspaces/${ws}/bots/${botId}/install/${dm}`, robin.cookie, {
      method: "PATCH",
      json: { brain: "The big one" },
    })) as { status: number; body: Dm };
    expect(picked.status).toBe(200);
    expect(picked.body.brain).toBe("The big one");

    reply = "On the big one now.";
    await say("who are you on?");
    await booted.bots.settled();
    expect(asked.at(-1)?.model).toBe("stub-2");
    // The newest run is first, and the ledger says which model was billed.
    expect((await runs())[0]?.model_id).toBe("stub-2");

    // A brain that is not here is refused, and putting it back is choosing nothing.
    const nonsense = await call(`/api/workspaces/${ws}/bots/${botId}/install/${dm}`, robin.cookie, {
      method: "PATCH",
      json: { brain: "Something else" },
    });
    expect(nonsense.status).toBe(422);
    const back = (await call(`/api/workspaces/${ws}/bots/${botId}/install/${dm}`, robin.cookie, {
      method: "PATCH",
      json: { brain: null },
    })) as { body: Dm };
    expect(back.body.brain).toBeNull();
  }, 60_000);

  test("a bot that does not offer the choice keeps the brain it was made with", async () => {
    const opened = (await call(`/api/workspaces/${ws}/bots/${plain}/dm`, robin.cookie, {
      method: "POST",
    })) as { status: number; body: Dm };
    expect(opened.status).toBe(200);
    expect(opened.body.can_pick_brain).toBe(false);
    const refused = await call(
      `/api/workspaces/${ws}/bots/${plain}/install/${opened.body.channel_id}`,
      robin.cookie,
      { method: "PATCH", json: { brain: "The big one" } },
    );
    expect(refused.status).toBe(409);
  }, 60_000);
});
