import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PerchBot, PerchBotError } from "@perch/bot-sdk";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.19 (spec §7.3): the Bot API. The acceptance is the third test — an external script, using
 * nothing but `@perch/bot-sdk` over HTTP and a WebSocket, posts a message and is told when somebody
 * says its name.
 *
 * The rest is what makes that safe: a token that names one bot, scopes that are refused rather than
 * narrowed, sixty calls a minute with a Retry-After, and channels the bot was actually put in.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let ws = "";
let cookie = "";
let botId = "";
let channelId = "";
let token = "";

beforeAll(async () => {
  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
});

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
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

type Id = { id: string };

describe("the Bot API (task 2.19)", () => {
  test("a bot, a channel it is installed in, and a token for it", async () => {
    const signed = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Ada",
        email: `ada-botapi-${Date.now()}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signed.status).toBe(200);
    cookie = cookiesFrom(signed);
    const made = (await call("/api/workspaces", {
      method: "POST",
      json: { name: "Bot Nest" },
    })) as { body: Id };
    ws = made.body.id;

    const channel = (await call(`/api/workspaces/${ws}/channels`, {
      method: "POST",
      json: { type: "public", name: "general" },
    })) as { status: number; body: Id };
    expect(channel.status).toBe(201);
    channelId = channel.body.id;

    const bot = (await call(`/api/workspaces/${ws}/bots`, {
      method: "POST",
      json: { handle: "scribe", name: "Scribe", level: "external" },
    })) as { status: number; body: Id };
    expect(bot.status).toBe(201);
    botId = bot.body.id;

    const installed = await call(`/api/workspaces/${ws}/bots/${botId}/install`, {
      method: "POST",
      json: { channel_id: channelId },
    });
    expect(installed.status).toBe(200);

    const minted = (await call(`/api/workspaces/${ws}/bots/${botId}/tokens`, {
      method: "POST",
      json: {
        name: "CI",
        scopes: ["chat:write", "chat:read", "channels:read", "files:write"],
      },
    })) as { status: number; text: string; body: { token: string; row: { hint: string } } };
    expect(minted.status).toBe(201);
    token = minted.body.token;
    expect(token.startsWith("pbot_")).toBe(true);
    expect(minted.body.row.hint).toContain("…");

    // The token is shown once: the list has the hint and nothing else.
    const listed = (await call(`/api/workspaces/${ws}/bots/${botId}/tokens`)) as {
      text: string;
      body: { tokens: { hint: string; scopes: string[] }[] };
    };
    expect(listed.body.tokens).toHaveLength(1);
    expect(listed.text).not.toContain(token);
    expect(listed.body.tokens[0]?.scopes).toEqual([
      "chat:write",
      "chat:read",
      "channels:read",
      "files:write",
    ]);
  }, 60_000);

  test("scopes are refused, not narrowed, and a stranger's token is nobody", async () => {
    const bot = new PerchBot({ url: base, token });
    // `sessions:open` was not minted, so the call is refused rather than quietly doing less.
    const refused = await bot.sessions
      .open({ project: crypto.randomUUID() })
      .catch((error: unknown) => error as PerchBotError);
    expect(refused).toBeInstanceOf(PerchBotError);
    expect((refused as PerchBotError).status).toBe(403);
    expect((refused as PerchBotError).message).toContain("sessions:open");

    const nobody = new PerchBot({ url: base, token: "pbot_not-a-real-token" });
    const denied = await nobody.conversations
      .list()
      .catch((error: unknown) => error as PerchBotError);
    expect((denied as PerchBotError).status).toBe(401);
  }, 60_000);

  test("an external script posts a message and receives an app_mention", async () => {
    const bot = new PerchBot({ url: base, token });

    // Socket mode first, so nothing said afterwards can be missed.
    const mentions: { text: string; by: string }[] = [];
    const heard: string[] = [];
    bot.on<{ text: string; mentioned_by: { id: string } }>("app_mention", (payload) => {
      mentions.push({ text: payload.text, by: payload.mentioned_by.id });
    });
    bot.on<{ text: string }>("message.created", (payload) => {
      heard.push(payload.text);
    });
    await bot.connect();

    // The channels it can see are the ones it was put in.
    const channels = await bot.conversations.list();
    expect(channels.map((one) => one.id)).toEqual([channelId]);

    // It posts, as itself.
    const posted = await bot.chat.postMessage({ channel: channelId, text: "reporting for duty" });
    expect(posted.ok).toBe(true);
    expect(posted.channel).toBe(channelId);

    // A person says its name in that channel…
    const said = await call(`/api/workspaces/${ws}/channels/${channelId}/messages`, {
      method: "POST",
      json: { text: "<@scribe> take a note" },
    });
    expect(said.status).toBe(201);

    // …and the script is told, over the socket, without asking for anything.
    const deadline = Date.now() + 15_000;
    while (mentions.length === 0 && Date.now() < deadline) await Bun.sleep(25);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.text).toContain("take a note");
    // A bot never hears its own message; it does hear the person's.
    expect(heard).toEqual(["<@scribe> take a note"]);

    // And it can answer in the thread, which is what a bot is for.
    const answered = await bot.chat.postMessage({
      channel: channelId,
      text: "noted",
      thread_ts: posted.message_id,
    });
    expect(answered.thread_ts).toBe(posted.message_id);

    const history = await bot.conversations.history({ channel: channelId });
    expect(history.map((one) => one.text)).toContain("reporting for duty");

    bot.disconnect();
  }, 60_000);

  test("a bot is told when somebody puts it in a channel", async () => {
    const bot = new PerchBot({ url: base, token });
    const joined: { channel_id: string; channel_name: string | null }[] = [];
    bot.on<{ channel_id: string; channel_name: string | null }>("channel.joined", (payload) => {
      joined.push({ channel_id: payload.channel_id, channel_name: payload.channel_name });
    });
    await bot.connect();

    const channel = (await call(`/api/workspaces/${ws}/channels`, {
      method: "POST",
      json: { type: "public", name: "newsroom" },
    })) as { body: Id };
    await call(`/api/workspaces/${ws}/bots/${botId}/install`, {
      method: "POST",
      json: { channel_id: channel.body.id },
    });

    const deadline = Date.now() + 15_000;
    while (joined.length === 0 && Date.now() < deadline) await Bun.sleep(25);
    expect(joined).toEqual([{ channel_id: channel.body.id, channel_name: "newsroom" }]);
    bot.disconnect();
  }, 60_000);

  test("a bot uploads a file, and saying it is what lets anybody read it", async () => {
    const bot = new PerchBot({ url: base, token });
    const uploaded = await bot.files.upload({
      file: new File(["colophon\n"], "notes.txt", { type: "text/plain" }),
    });
    expect(uploaded.name).toBe("notes.txt");
    expect(uploaded.size).toBe(9);
    expect(uploaded.url).toBe(`/api/files/${uploaded.id}`);

    // Nobody can read it yet: an upload nobody has posted belongs to whoever made it (ADR-0094).
    const early = await fetch(`${base}${uploaded.url}`, { headers: { cookie } });
    expect(early.status).toBe(404);

    await bot.chat.postMessage({
      channel: channelId,
      blocks: [{ type: "file", fileId: uploaded.id, text: "the notes" }],
    });
    const fetched = await fetch(`${base}${uploaded.url}`, { headers: { cookie } });
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe("colophon\n");
  }, 60_000);

  test("sixty calls a minute, and the sixty-first says how long to wait", async () => {
    const bot = new PerchBot({ url: base, token });
    // The window is per bot and this test shares it with the ones above, so the count is what is
    // left rather than sixty: what matters is that it stops and says Retry-After.
    let refused: PerchBotError | null = null;
    for (let at = 0; at < 70 && !refused; at++) {
      refused = await bot.conversations
        .list()
        .then(() => null)
        .catch((error: unknown) => error as PerchBotError);
    }
    expect(refused).toBeInstanceOf(PerchBotError);
    expect(refused?.status).toBe(429);
    expect(refused?.retryAfter).toBeGreaterThan(0);
    expect(refused?.retryAfter).toBeLessThanOrEqual(60);
  }, 60_000);

  test("a revoked token stops working", async () => {
    // Its own bot, because the minute the test above spent belongs to `scribe` (§7.3 counts per bot).
    const second = (await call(`/api/workspaces/${ws}/bots`, {
      method: "POST",
      json: { handle: "clerk", name: "Clerk", level: "external" },
    })) as { body: Id };
    const minted = (await call(`/api/workspaces/${ws}/bots/${second.body.id}/tokens`, {
      method: "POST",
      json: { name: "Throwaway", scopes: ["channels:read"] },
    })) as { body: { token: string; row: Id } };
    const throwaway = new PerchBot({ url: base, token: minted.body.token });
    // It was never installed anywhere, so it sees nothing — and that is still a working token.
    expect(await throwaway.conversations.list()).toHaveLength(0);

    const revoked = await call(
      `/api/workspaces/${ws}/bots/${second.body.id}/tokens/${minted.body.row.id}`,
      { method: "DELETE" },
    );
    expect(revoked.status).toBe(204);
    const denied = await throwaway.conversations
      .list()
      .catch((error: unknown) => error as PerchBotError);
    expect((denied as PerchBotError).status).toBe(401);
  }, 60_000);
});
