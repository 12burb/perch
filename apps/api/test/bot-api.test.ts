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
let provider: ReturnType<typeof Bun.serve> | null = null;
let ws = "";
let cookie = "";
let botId = "";
let channelId = "";
let token = "";
let toolToken = "";

beforeAll(async () => {
  // The provider a workspace connection is checked against when it is made. What this file is
  // about is the grant in front of it, so it only has to answer.
  provider = Bun.serve({ port: 0, fetch: () => Response.json({ user: { username: "nest" } }) });
  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  provider?.stop(true);
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

    // A second token for the tool tests, so the first keeps exactly the scopes it was minted with.
    const forTools = (await call(`/api/workspaces/${ws}/bots/${botId}/tokens`, {
      method: "POST",
      json: { name: "Tools", scopes: ["tools:call"] },
    })) as { body: { token: string } };
    toolToken = forTools.body.token;

    // The token is shown once: the list has the hint and nothing else.
    const listed = (await call(`/api/workspaces/${ws}/bots/${botId}/tokens`)) as {
      text: string;
      body: { tokens: { hint: string; scopes: string[] }[] };
    };
    expect(listed.body.tokens).toHaveLength(2);
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

  test("a button press reaches the script, and it rewrites the message in place", async () => {
    const bot = new PerchBot({ url: base, token });
    const presses: { action: string; values: Record<string, string>; message_id: string }[] = [];
    bot.on<{ action: string; values: Record<string, string>; message_id: string }>(
      "interaction.received",
      (payload) => {
        presses.push({
          action: payload.action,
          values: payload.values,
          message_id: payload.message_id,
        });
      },
    );
    await bot.connect();

    // The bot asks, in blocks, the way a bot asks anything a person has to answer.
    const asked = await bot.chat.postMessage({
      channel: channelId,
      blocks: [{ type: "approve_deny", id: "ship", action: "deploy.ship", text: "Ship it?" }],
    });
    expect(asked.ok).toBe(true);

    // A person presses it.
    const pressed = await call(`/api/workspaces/${ws}/messages/${asked.message_id}/interactions`, {
      method: "POST",
      json: { block_id: "ship", values: { decision: "approved" } },
    });
    expect(pressed.status).toBe(200);

    // The script is told, over its own socket.
    const deadline = Date.now() + 15_000;
    while (presses.length === 0 && Date.now() < deadline) await Bun.sleep(25);
    expect(presses).toHaveLength(1);
    expect(presses[0]?.action).toBe("deploy.ship");
    expect(presses[0]?.values).toEqual({ decision: "approved" });
    expect(presses[0]?.message_id).toBe(asked.message_id);

    // And it closes the loop by rewriting what it said, rather than saying it twice.
    const rewritten = await bot.chat.update({
      ts: asked.message_id,
      text: "Shipping, because you said so.",
    });
    expect(rewritten.message_id).toBe(asked.message_id);
    const history = await bot.conversations.history({ channel: channelId });
    const now = history.find((one) => one.message_id === asked.message_id);
    expect(now?.text).toContain("Shipping, because you said so.");
    expect(history.filter((one) => one.text.includes("Shipping"))).toHaveLength(1);

    bot.disconnect();
  }, 60_000);

  test("a connection is a bot's only when somebody granted it, and only its listed tools", async () => {
    const bot = new PerchBot({ url: base, token: toolToken });
    const made = (await call(`/api/workspaces/${ws}/connections`, {
      method: "POST",
      json: {
        kind: "token",
        provider: "vercel",
        token: "stand-in",
        owner_type: "workspace",
        api_base: provider?.url.origin ?? "",
      },
    })) as { status: number; body: Id };
    expect(made.status).toBe(201);

    // Ungranted: refused before anything upstream is asked (spec §3.5).
    const refused = await bot.tools
      .call({ connection_id: made.body.id, tool: "list_projects" })
      .catch((error: unknown) => error as PerchBotError);
    expect((refused as PerchBotError).status).toBe(403);
    expect((refused as PerchBotError).message).toContain("granted");

    // Granted, but only for what the grant lists.
    const granted = await call(`/api/workspaces/${ws}/connections/${made.body.id}/grants`, {
      method: "POST",
      json: { subject_type: "bot", subject_id: botId, allowed_tools: ["list_projects"] },
    });
    expect(granted.status).toBe(201);

    const offList = await bot.tools
      .call({ connection_id: made.body.id, tool: "delete_project" })
      .catch((error: unknown) => error as PerchBotError);
    expect((offList as PerchBotError).status).toBe(403);
    expect((offList as PerchBotError).message).toContain("delete_project");

    // The listed one gets past the grant; what happens at the far end is the provider's business,
    // and the stand-in is not an MCP server — what matters here is that it was not the grant.
    const allowed = await bot.tools
      .call({ connection_id: made.body.id, tool: "list_projects" })
      .catch((error: unknown) => error as PerchBotError);
    expect((allowed as PerchBotError).message ?? "").not.toContain("granted");
    expect((allowed as PerchBotError).message ?? "").not.toContain("may not call");

    // And the audit says a bot called it, in both places it says who: the row's actor, and the
    // event's own `callerType`, which used to be written as "user" whoever called (task 3.3).
    const audit = (await call(`/api/workspaces/${ws}/audit?limit=200&action=tools.called`)) as {
      body: { rows: { action: string; actor_type: string; details: { callerType?: string } }[] };
    };
    const calls = audit.body.rows.filter((one) => one.action === "tools.called");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((one) => one.actor_type === "bot")).toBe(true);
    expect(calls.every((one) => one.details.callerType === "bot")).toBe(true);
    // The refusal is audited too: a denied call is a thing that happened.
    expect(calls.some((one) => (one.details as { outcome?: string }).outcome === "denied")).toBe(
      true,
    );
  }, 60_000);

  test("a grant is revoked on its own connection only, and a tool that needs a person is not a bot's", async () => {
    const bot = new PerchBot({ url: base, token: toolToken });
    const other = (await call(`/api/workspaces/${ws}/connections`, {
      method: "POST",
      json: {
        kind: "token",
        provider: "vercel",
        token: "stand-in-two",
        owner_type: "workspace",
        api_base: provider?.url.origin ?? "",
      },
    })) as { status: number; body: Id };
    expect(other.status).toBe(201);
    const granted = (await call(`/api/workspaces/${ws}/connections/${other.body.id}/grants`, {
      method: "POST",
      json: {
        subject_type: "bot",
        subject_id: botId,
        allowed_tools: ["list_projects", "delete_project"],
        requires_permission: ["delete_project"],
      },
    })) as { status: number; body: { id: string } };
    expect(granted.status).toBe(201);

    // Revoking it through another connection's route finds nothing (spec §9.1 scoping) …
    const first = (await call(`/api/workspaces/${ws}/connections`)) as {
      body: { connections: Id[] };
    };
    const elsewhere = first.body.connections.find((one) => one.id !== other.body.id);
    expect(elsewhere).toBeDefined();
    const wrong = await call(
      `/api/workspaces/${ws}/connections/${elsewhere?.id}/grants/${granted.body.id}`,
      { method: "DELETE" },
    );
    expect(wrong.status).toBe(404);
    // … and the grant is still there.
    const listed = (await call(`/api/workspaces/${ws}/connections/${other.body.id}/grants`)) as {
      body: { grants: { id: string }[] };
    };
    expect(listed.body.grants.map((one) => one.id)).toContain(granted.body.id);

    // A tool the grant says needs a person's permission each time (task 3.6) has nobody to ask on
    // this path, so an outside bot is refused it — and still gets the tool that needs nobody.
    const asked = await bot.tools
      .call({ connection_id: other.body.id, tool: "delete_project" })
      .catch((error: unknown) => error as PerchBotError);
    expect((asked as PerchBotError).status).toBe(403);
    expect((asked as PerchBotError).message).toContain("permission");
    const plain = await bot.tools
      .call({ connection_id: other.body.id, tool: "list_projects" })
      .catch((error: unknown) => error as PerchBotError);
    expect((plain as PerchBotError).message ?? "").not.toContain("permission");
    expect((plain as PerchBotError).message ?? "").not.toContain("granted");
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

/**
 * Code review (ADR-0176): a bot's token names one workspace, and nothing the Bot API says or hears
 * crosses out of it — not an event on the socket, not a person's name.
 */
describe("the Bot API stays inside its workspace", () => {
  let other = { cookie: "", ws: "", userId: "" };
  let herald = { id: "", token: "" };
  let outsider = { id: "", token: "" };

  async function as(who: string, path: string, init: { method?: string; json?: unknown } = {}) {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: { cookie: who, "content-type": "application/json", origin: base },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
    const text = await res.text();
    return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
  }

  async function botWithToken(
    who: string,
    workspace: string,
    handle: string,
    scopes: string[],
    channel?: string,
  ) {
    const made = (await as(who, `/api/workspaces/${workspace}/bots`, {
      method: "POST",
      json: { handle, name: handle, level: "external" },
    })) as { status: number; text: string; body: Id };
    expect(made.status, made.text).toBe(201);
    if (channel) {
      const installed = await as(who, `/api/workspaces/${workspace}/bots/${made.body.id}/install`, {
        method: "POST",
        json: { channel_id: channel },
      });
      expect(installed.status).toBe(200);
    }
    const minted = (await as(who, `/api/workspaces/${workspace}/bots/${made.body.id}/tokens`, {
      method: "POST",
      json: { name: `${handle}-token`, scopes },
    })) as { status: number; body: { token: string } };
    expect(minted.status).toBe(201);
    return { id: made.body.id, token: minted.body.token };
  }

  test("a second workspace, somebody who is only in it, and a bot in each", async () => {
    const signed = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Bo",
        email: `bo-botapi-${Date.now()}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signed.status).toBe(200);
    const boCookie = cookiesFrom(signed);
    const me = (await as(boCookie, "/api/me")) as { body: Id };
    const made = (await as(boCookie, "/api/workspaces", {
      method: "POST",
      json: { name: "Elsewhere" },
    })) as { body: Id };
    other = { cookie: boCookie, ws: made.body.id, userId: me.body.id };

    // A dot in the handle, which the native runtime's mentions have always matched.
    herald = await botWithToken(
      cookie,
      ws,
      "herald.ai",
      ["chat:write", "chat:read", "channels:read", "work:write"],
      channelId,
    );
    outsider = await botWithToken(other.cookie, other.ws, "outsider", ["channels:read"]);
  }, 60_000);

  test("a socket hears its own workspace's news and nobody else's", async () => {
    const heard: { bot: string; type: string; workspace: string }[] = [];
    const listen = (name: string, bot: PerchBot) => {
      for (const type of ["session.completed", "work_item.updated", "interaction.received"]) {
        bot.on<{ workspace_id: string }>(type as "session.completed", (payload) => {
          heard.push({ bot: name, type, workspace: payload.workspace_id });
        });
      }
    };
    const inside = new PerchBot({ url: base, token: herald.token });
    const outside = new PerchBot({ url: base, token: outsider.token });
    listen("herald", inside);
    listen("outsider", outside);
    await inside.connect();
    await outside.connect();

    const now = new Date().toISOString();
    const session = (workspace: string) => ({
      type: "session.completed" as const,
      botId: null,
      workspaceId: workspace,
      ts: now,
      payload: {
        workspace_id: workspace,
        session_id: crypto.randomUUID(),
        project_id: crypto.randomUUID(),
        status: "ended",
        message: null,
        ts: now,
      },
    });
    await booted.botEvents.emit(session(ws));
    // A button pressed on a block a person posted belongs to no bot, so no bot hears it.
    await booted.botEvents.emit({
      type: "interaction.received",
      botId: null,
      workspaceId: ws,
      ts: now,
      payload: {
        workspace_id: ws,
        channel_id: channelId,
        message_id: crypto.randomUUID(),
        block_id: "b1",
        action: "form.submit",
        block_type: "form",
        values: { answer: "private" },
        user: { type: "user", id: crypto.randomUUID() },
        at: now,
      },
    });
    // The other workspace's own news, last, so its arrival says everything before it has landed.
    await booted.botEvents.emit(session(other.ws));

    const deadline = Date.now() + 15_000;
    while (heard.filter((one) => one.bot === "outsider").length === 0 && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    await Bun.sleep(100);
    expect(heard.filter((one) => one.bot === "outsider")).toEqual([
      { bot: "outsider", type: "session.completed", workspace: other.ws },
    ]);
    expect(heard.filter((one) => one.bot === "herald")).toEqual([
      { bot: "herald", type: "session.completed", workspace: ws },
    ]);
    inside.disconnect();
    outside.disconnect();
  }, 60_000);

  test("a mention the native runtime hears is one an outside bot hears too", async () => {
    const bot = new PerchBot({ url: base, token: herald.token });
    const mentions: string[] = [];
    bot.on<{ text: string }>("app_mention", (payload) => {
      mentions.push(payload.text);
    });
    await bot.connect();
    const said = await call(`/api/workspaces/${ws}/channels/${channelId}/messages`, {
      method: "POST",
      json: { text: "a question for (@herald.ai) about <@herald.ai>" },
    });
    expect(said.status).toBe(201);
    const deadline = Date.now() + 15_000;
    while (mentions.length === 0 && Date.now() < deadline) await Bun.sleep(25);
    expect(mentions).toEqual(["a question for (@herald.ai) about <@herald.ai>"]);
    bot.disconnect();
  }, 60_000);

  test("users.info knows the people in the bot's workspace, and nobody else", async () => {
    const headers = { authorization: `Bearer ${herald.token}` };
    const me = (await call("/api/me")) as { body: Id };
    const known = await fetch(`${base}/api/bot/users.info?user=${me.body.id}`, { headers });
    expect(known.status).toBe(200);
    const stranger = await fetch(`${base}/api/bot/users.info?user=${other.userId}`, { headers });
    expect(stranger.status).toBe(404);
  }, 60_000);

  test("work.create puts an item on a board in the bot's own workspace", async () => {
    const project = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "the-board" },
    })) as { status: number; text: string; body: Id };
    expect(project.status, project.text).toBe(201);
    const post = (token: string, json: unknown) =>
      fetch(`${base}/api/bot/work.create`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(json),
      });

    // Through the SDK, the way a bot author would write it.
    const { item } = await new PerchBot({ url: base, token: herald.token }).work.create({
      project: project.body.id,
      title: "Rotate the staging key",
      type: "bug",
      priority: 2,
    });
    expect(item.title).toBe("Rotate the staging key");
    expect(item.type).toBe("bug");
    expect(item.state).toBe("backlog");
    expect(item.identifier).toMatch(/^[A-Z0-9-]+-1$/);
    const board = (await call(`/api/workspaces/${ws}/projects/${project.body.id}/work-items`)) as {
      body: { items: { id: string; source?: string }[] };
    };
    expect(board.body.items.map((one) => one.id)).toContain(item.id);

    // A token without the scope is refused, and a project in another workspace is not there.
    expect((await post(outsider.token, { project: project.body.id, title: "x" })).status).toBe(403);
    const elsewhere = (await as(other.cookie, `/api/workspaces/${other.ws}/projects`, {
      method: "POST",
      json: { name: "not-yours" },
    })) as { body: Id };
    expect((await post(herald.token, { project: elsewhere.body.id, title: "x" })).status).toBe(404);
  }, 60_000);
});

/**
 * Code review (ADR-0176): an `app_mention` carries the chain state spec §5.4 keeps — which hop it is,
 * how a bot meant the tag, what is left of the thread's budget — and a hop the rails forbid is not
 * a mention the bot hears. Two outside bots tagging each other meet the same repeat-pair breaker
 * two native bots would.
 */
describe("app_mention and the chain rails", () => {
  test("hops are counted between outside bots, and a pair that keeps bouncing is stopped", async () => {
    const make = async (handle: string) => {
      const made = (await call(`/api/workspaces/${ws}/bots`, {
        method: "POST",
        json: { handle, name: handle, level: "external" },
      })) as { status: number; body: Id };
      expect(made.status).toBe(201);
      await call(`/api/workspaces/${ws}/bots/${made.body.id}/install`, {
        method: "POST",
        json: { channel_id: channelId },
      });
      const minted = (await call(`/api/workspaces/${ws}/bots/${made.body.id}/tokens`, {
        method: "POST",
        json: { name: handle, scopes: ["chat:write", "chat:read"] },
      })) as { body: { token: string } };
      const bot = new PerchBot({ url: base, token: minted.body.token });
      const heard: { text: string; hop: number; mode: string | null; left: number | null }[] = [];
      bot.on<{ text: string; hop: number; mode: string | null; budget_remaining: number | null }>(
        "app_mention",
        (payload) => {
          heard.push({
            text: payload.text,
            hop: payload.hop,
            mode: payload.mode,
            left: payload.budget_remaining,
          });
        },
      );
      await bot.connect();
      return { bot, heard };
    };
    const one = await make("relay-one");
    const two = await make("relay-two");
    const until = async (list: unknown[], count: number) => {
      const deadline = Date.now() + 15_000;
      while (list.length < count && Date.now() < deadline) await Bun.sleep(25);
    };

    const root = (await call(`/api/workspaces/${ws}/channels/${channelId}/messages`, {
      method: "POST",
      json: { text: "<@relay-one> start a chain" },
    })) as { status: number; body: Id };
    expect(root.status).toBe(201);
    await until(one.heard, 1);
    // A person's tag is the first hop, and has no mode.
    expect(one.heard[0]).toMatchObject({ hop: 1, mode: null, left: null });

    await one.bot.chat.postMessage({
      channel: channelId,
      text: "<@relay-two> over to you",
      thread_ts: root.body.id,
    });
    await until(two.heard, 1);
    // A bot's tag is the next hop, a consult unless it said otherwise.
    expect(two.heard[0]).toMatchObject({ hop: 2, mode: "consult" });

    await two.bot.chat.postMessage({
      channel: channelId,
      text: "<@relay-one> and back",
      thread_ts: root.body.id,
    });
    await until(one.heard, 2);
    expect(one.heard[1]).toMatchObject({ hop: 3, mode: "consult" });

    // One -> two -> one -> two would be the pair's third bounce: the breaker stops it.
    await one.bot.chat.postMessage({
      channel: channelId,
      text: "<@relay-two> and again",
      thread_ts: root.body.id,
    });
    await Bun.sleep(500);
    expect(two.heard).toHaveLength(1);

    one.bot.disconnect();
    two.bot.disconnect();
  }, 60_000);
});
