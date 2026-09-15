import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { getBot } from "../src/repos/bots.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { fetchable, mentionsIn, readable } from "../src/services/bots.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.6 (spec §5.3): the native bot runtime. The acceptance is the last test here — a bot
 * answers a mention, in the thread, within its budget, and the run says what it cost.
 *
 * The model is a stub OpenAI-compatible endpoint rather than a mocked client, so what this covers
 * is the whole lane: the credential in the vault, the gateway building a model from the profile,
 * the streamed answer, and the placeholder becoming the reply.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let model: ReturnType<typeof Bun.serve> | null = null;
let modelUrl = "";
let ws = "";
let channel = "";
let robin = { cookie: "", id: "" };
let wren = { cookie: "", id: "" };
const asked: string[] = [];
let reply = "The plan is to deploy on Friday.";

beforeAll(async () => {
  // An OpenAI-compatible endpoint: it lists one model and streams whatever `reply` says.
  model = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "stub-1" }] });
      }
      if (!url.pathname.endsWith("/chat/completions")) return new Response("no", { status: 404 });
      const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
      asked.push(JSON.stringify(body.messages));
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

type BotBody = {
  id: string;
  handle: string;
  name: string;
  visibility: string;
  status: string;
  channels: string[];
};
type MessageBody = {
  id: string;
  author_type: string;
  author_id: string;
  author_name: string | null;
  thread_root_id: string | null;
  blocks: { type: string; text?: string }[];
  edited_at: string | null;
};
type RunBody = {
  id: string;
  trigger: string;
  status: string;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error: string | null;
};

const say = (cookie: string, text: string, threadRootId?: string) =>
  call(`/api/workspaces/${ws}/channels/${channel}/messages`, cookie, {
    method: "POST",
    json: { text, ...(threadRootId ? { thread_root_id: threadRootId } : {}) },
  }) as Promise<{ status: number; body: MessageBody }>;

const flow = async (threadRootId?: string) => {
  const path = threadRootId
    ? `/api/workspaces/${ws}/messages/${threadRootId}/thread`
    : `/api/workspaces/${ws}/channels/${channel}/messages`;
  const res = (await call(path, robin.cookie)) as { body: { messages: MessageBody[] } };
  return res.body.messages;
};

const runs = async (botId: string) => {
  const res = (await call(`/api/workspaces/${ws}/bots/${botId}/runs`, robin.cookie)) as {
    body: { runs: RunBody[] };
  };
  return res.body.runs;
};

describe("bot plumbing (task 2.6)", () => {
  test("a mention is a handle, and a page is read as text without its scripts", () => {
    expect(mentionsIn("morning <@news> and @Robin")).toEqual(["news", "robin"]);
    expect(mentionsIn("an email@example.com is not one")).toEqual([]);
    expect(readable("<p>Hello <b>world</b></p><script>steal()</script>")).toBe("Hello world");
  });

  test("a bot cannot be pointed at the network Perch runs on", () => {
    expect(() => fetchable("https://example.test/page")).not.toThrow();
    for (const url of [
      "http://localhost:3000/",
      "http://127.0.0.1/",
      "http://10.1.2.3/",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.0.5/",
      "http://[::1]/",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(() => fetchable(url)).toThrow();
    }
  });
});

describe("a native bot (task 2.6)", () => {
  let botId = "";

  test("a bot is made, given a brain, and put in a channel", async () => {
    const stamp = Date.now();
    robin = await signUp("Robin", `robin-bot-${stamp}@perch.test`);
    wren = await signUp("Wren", `wren-bot-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", robin.cookie, {
      method: "POST",
      json: { name: "Bot Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, robin.cookie, {
      method: "POST",
      json: { email: `wren-bot-${stamp}@perch.test`, role: "member" },
    })) as { body: { accept_url: string } };
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    expect(
      (await call(`/api/invites/${token}/accept`, wren.cookie, { method: "POST" })).status,
    ).toBe(200);
    const created = (await call(`/api/workspaces/${ws}/channels`, robin.cookie, {
      method: "POST",
      json: { type: "public", name: "newsroom" },
    })) as { body: { id: string } };
    channel = created.body.id;

    // The brain: an endpoint credential and a profile, the same way a person would add one.
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
    const profile = (await call(`/api/workspaces/${ws}/model-profiles`, robin.cookie, {
      method: "POST",
      json: {
        name: "Stub brain",
        provider: "custom",
        model_id: "stub-1",
        credential_id: credential.body.id,
        default_for: "chat",
      },
    })) as { status: number };
    expect(profile.status).toBe(201);

    const bot = (await call(`/api/workspaces/${ws}/bots`, robin.cookie, {
      method: "POST",
      json: {
        handle: "news",
        name: "Newsroom",
        visibility: "workspace",
        spec: {
          persona: "You keep the newsroom posted.",
          brain: { profile: "Stub brain" },
          triggers: [{ on: "mention" }],
          tools: [],
        },
        budget: { dailyUsd: 5 },
      },
    })) as { status: number; body: BotBody };
    expect(bot.status).toBe(201);
    expect(bot.body.handle).toBe("news");
    botId = bot.body.id;

    // A handle is somebody's name: two bots cannot share one, and neither can a bot and a person.
    const twice = await call(`/api/workspaces/${ws}/bots`, robin.cookie, {
      method: "POST",
      json: { handle: "NEWS", name: "Another" },
    });
    expect(twice.status).toBe(409);

    const installed = (await call(`/api/workspaces/${ws}/bots/${botId}/install`, robin.cookie, {
      method: "POST",
      json: { channel_id: channel },
    })) as { status: number; body: BotBody };
    expect(installed.status).toBe(200);
    expect(installed.body.channels).toEqual([channel]);

    // It is a member of the channel now, like anybody else in it.
    const members = (await call(
      `/api/workspaces/${ws}/channels/${channel}/members`,
      robin.cookie,
    )) as { body: { members: { member_type: string; member_id: string }[] } };
    expect(members.body.members.some((m) => m.member_type === "bot" && m.member_id === botId)).toBe(
      true,
    );
  }, 60_000);

  test("it answers a mention in the thread, and the run says what it cost", async () => {
    asked.length = 0;
    reply = "The plan is to deploy on Friday.";
    const question = await say(robin.cookie, "<@news> what is the plan?");
    expect(question.status).toBe(201);
    await booted.bots.settled();

    // The answer hangs off what was asked (spec §5.4 "always reply in-thread").
    const thread = await flow(question.body.id);
    const answer = thread.find((row) => row.author_type === "bot");
    expect(answer).toBeDefined();
    expect(answer?.author_id).toBe(botId);
    expect(answer?.author_name).toBe("Newsroom");
    expect(answer?.blocks[0]?.text).toBe("The plan is to deploy on Friday.");
    // Streaming a reply into a placeholder is not an edit: no "(edited)" on a bot's message.
    expect(answer?.edited_at).toBeNull();

    // The channel itself keeps its shape: the reply is in the thread, not in the flow.
    const main = await flow();
    expect(main.filter((row) => row.author_type === "bot")).toHaveLength(0);

    // What the model was shown: the workspace's people by name, and nothing else.
    expect(asked[0]).toContain("Robin: <@news> what is the plan?");

    const ledger = await runs(botId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      trigger: "mention",
      status: "done",
      model_id: "stub-1",
      input_tokens: 120,
      output_tokens: 30,
      error: null,
    });
  }, 60_000);

  test("it stays quiet when nobody named it, and never answers itself", async () => {
    const before = (await runs(botId)).length;
    await say(robin.cookie, "just talking among ourselves");
    await booted.bots.settled();
    expect((await runs(botId)).length).toBe(before);
  }, 60_000);

  test("the test chat answers whoever asked, without saying it in the channel", async () => {
    reply = "Tested and well.";
    const before = (await flow()).length;
    const tested = (await call(`/api/workspaces/${ws}/bots/${botId}/test`, robin.cookie, {
      method: "POST",
      json: { text: "are you there?", channel_id: channel },
    })) as { status: number; body: { reply: string; run: RunBody } };
    expect(tested.status).toBe(200);
    expect(tested.body.reply).toBe("Tested and well.");
    expect(tested.body.run.trigger).toBe("test");
    expect((await flow()).length).toBe(before);
  }, 60_000);

  test("a bot that has spent its budget says so instead of answering", async () => {
    const paused = await call(`/api/workspaces/${ws}/bots/${botId}`, robin.cookie, {
      method: "PATCH",
      json: { budget: { perHourRuns: 1 } },
    });
    expect(paused.status).toBe(200);

    reply = "This should never be said.";
    const question = await say(robin.cookie, "<@news> and now?");
    await booted.bots.settled();
    const thread = await flow(question.body.id);
    const answer = thread.find((row) => row.author_type === "bot");
    expect(answer?.blocks[0]?.text).toContain("as often as it may this hour");

    const refused = (await runs(botId)).find((row) => row.status === "refused");
    expect(refused).toBeDefined();
    expect(refused?.error).toContain("as often as it may this hour");
  }, 60_000);

  test("a scheduled trigger is a row in the queue, and fires into the channel it names", async () => {
    // Back to a budget that allows a run, and a spec that carries a schedule.
    const updated = (await call(`/api/workspaces/${ws}/bots/${botId}`, robin.cookie, {
      method: "PATCH",
      json: {
        budget: { dailyUsd: 5 },
        spec: {
          persona: "You keep the newsroom posted.",
          brain: { profile: "Stub brain" },
          triggers: [
            { on: "mention" },
            {
              on: "schedule",
              cron: "0 9 * * 1-5",
              prompt: "post today's headlines",
              channel: "newsroom",
            },
          ],
          tools: [],
        },
      },
    })) as { status: number };
    expect(updated.status).toBe(200);

    // The schedule is in the queue, keyed by the bot and the trigger's place among its schedules.
    const row = await getBot(booted.db.db, botId);
    expect(row).not.toBeNull();
    if (row) expect(await booted.bots.reschedule(row)).toEqual([`bot:${botId}:0`]);

    reply = "Two things happened today.";
    const before = (await flow()).length;
    await booted.bots.runScheduled({ botId, index: 0 });
    await booted.bots.settled();

    // A schedule has no message to hang off, so it says its piece in the channel itself.
    const main = await flow();
    expect(main.length).toBe(before + 1);
    expect(main.at(-1)?.blocks[0]?.text).toBe("Two things happened today.");
    expect((await runs(botId)).some((row) => row.trigger === "schedule")).toBe(true);
  }, 60_000);

  test("a private bot is its owner's alone", async () => {
    const mine = (await call(`/api/workspaces/${ws}/bots`, wren.cookie, {
      method: "POST",
      json: { handle: "wrenbot", name: "Wren's own" },
    })) as { status: number; body: BotBody };
    expect(mine.status).toBe(201);
    expect(mine.body.visibility).toBe("private");

    // Robin owns the workspace and still cannot see somebody's private bot.
    const listed = (await call(`/api/workspaces/${ws}/bots`, robin.cookie)) as {
      body: { bots: BotBody[] };
    };
    expect(listed.body.bots.map((row) => row.handle)).toEqual(["news"]);
    expect((await call(`/api/workspaces/${ws}/bots/${mine.body.id}`, robin.cookie)).status).toBe(
      404,
    );

    // And a member cannot make one the whole workspace can talk to.
    const shared = await call(`/api/workspaces/${ws}/bots`, wren.cookie, {
      method: "POST",
      json: { handle: "shared", name: "Shared", visibility: "workspace" },
    });
    expect(shared.status).toBe(403);
  }, 60_000);
});
