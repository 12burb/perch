import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PerchBot } from "@perch/bot-sdk";
import { NEST_AGENTS } from "@perch/bots/nest";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.9 (spec §5.3 "Nest agents (Birbus orchestrator; Dawn, Julius, Paige, Kimi specialists)
 * join via the Bot API or the hermes adapter").
 *
 * The acceptance §10 names is the second test: a Nest agent posts via the Bot API using a granted
 * Supabase connection. It is run end to end — the roster installed as real bots, a real token, a
 * stand-in Supabase behind a real MCP server, and `@perch/bot-sdk` over HTTP, the way something
 * outside Perch would do it — so what it proves is the whole path and not a shape.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let upstream: ReturnType<typeof Bun.serve> | null = null;
let upstreamUrl = "";
let cookie = "";
let ws = "";
let channelId = "";

/** Supabase's own credential. It must reach the stand-in and nothing else. */
const PAT = "sbp_nest00000000000000000000000000000000";
const seen: { path: string; auth: string | null }[] = [];
const called: { name: string; args: unknown }[] = [];

function supabase(): Server {
  const server = new Server({ name: "stand-in", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_tables",
        description: "The tables in a schema",
        inputSchema: { type: "object" as const, properties: { schemas: { type: "array" } } },
      },
      {
        name: "execute_sql",
        description: "Run a read-only query",
        inputSchema: { type: "object" as const, properties: { query: { type: "string" } } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    called.push({ name: request.params.name, args: request.params.arguments });
    return {
      content: [{ type: "text" as const, text: "signups_last_week = 412" }],
    };
  });
  return server;
}

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const auth = request.headers.get("authorization");
      seen.push({ path: url.pathname, auth });
      // The paste lane checks a token against the provider before keeping it.
      if (url.pathname === "/v1/projects") {
        if (auth !== `Bearer ${PAT}`) return Response.json({ message: "no" }, { status: 401 });
        return Response.json([{ id: "proj", name: "The Nest" }]);
      }
      if (url.pathname !== "/mcp") return Response.json({ message: "no" }, { status: 404 });
      if (auth !== `Bearer ${PAT}`) {
        return Response.json({ message: "Unauthorized" }, { status: 401 });
      }
      const server = supabase();
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  });
  upstreamUrl = `http://127.0.0.1:${upstream.port}`;
  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  upstream?.stop(true);
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

type Installed = {
  handle: string;
  name: string;
  bot_id: string;
  door: string;
  token?: string;
  connections: string[];
};
type NestBody = { installed: Installed[]; already: string[] };

let kimi: Installed | undefined;

describe("the Nest (task 3.9)", () => {
  test("the roster installs as ordinary bots, each through its own door", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-nest-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    const made = (await call("/api/workspaces", {
      method: "POST",
      json: { name: "The Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const room = (await call(`/api/workspaces/${ws}/channels`, {
      method: "POST",
      json: { type: "public", name: "nest" },
    })) as { body: { id: string } };
    channelId = room.body.id;

    // Nobody is here yet.
    const before = (await call(`/api/workspaces/${ws}/nest`)) as {
      body: { agents: { handle: string; installed: boolean; door: string }[] };
    };
    expect(before.body.agents).toHaveLength(NEST_AGENTS.length);
    expect(before.body.agents.every((one) => !one.installed)).toBe(true);

    const installed = (await call(`/api/workspaces/${ws}/nest`, { method: "POST", json: {} })) as {
      status: number;
      text: string;
      body: NestBody;
    };
    expect(installed.status, installed.text).toBe(201);
    expect(installed.body.installed.map((one) => one.handle).sort()).toEqual(
      NEST_AGENTS.map((one) => one.handle).sort(),
    );
    // The door decides what the bot is: a token for the ones that talk over the Bot API, and none
    // for Dawn, whom Perch runs itself on the hermes engine.
    const byHandle = new Map(installed.body.installed.map((one) => [one.handle, one]));
    expect(byHandle.get("dawn")?.door).toBe("hermes");
    expect(byHandle.get("dawn")?.token).toBeUndefined();
    expect(byHandle.get("birbus")?.token).toMatch(/\S/);
    kimi = byHandle.get("kimi");
    expect(kimi?.connections).toEqual(["supabase"]);

    // They are bots like any other: Birbus is the one that may tag the rest.
    const bots = (await call(`/api/workspaces/${ws}/bots`)) as {
      body: {
        bots: { handle: string; level: string; visibility: string; orchestrator: boolean }[];
      };
    };
    const birbus = bots.body.bots.find((one) => one.handle === "birbus");
    expect(birbus).toMatchObject({
      level: "external",
      visibility: "workspace",
      orchestrator: true,
    });
    expect(bots.body.bots.find((one) => one.handle === "dawn")?.level).toBe("ui");

    // Installing again takes nobody's name: what is here stays exactly as it is.
    const again = (await call(`/api/workspaces/${ws}/nest`, { method: "POST", json: {} })) as {
      status: number;
      body: NestBody;
    };
    expect(again.status).toBe(201);
    expect(again.body.installed).toEqual([]);
    expect(again.body.already.sort()).toEqual(NEST_AGENTS.map((one) => one.handle).sort());
  }, 60_000);

  test("a person called Dawn somewhere else does not stop this workspace having @dawn", async () => {
    // A handle is what somebody types after an `@`, and a mention is resolved inside a workspace.
    // An instance-wide check made one person's name a bot nobody could install (task 3.24).
    const stamp = Date.now();
    const elsewhere = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Dawn",
        // The handle comes from the address, so this is a person whose handle is exactly `dawn`.
        email: "dawn@perch.test",
        password: "correct horse battery staple",
      }),
    });
    expect(elsewhere.status).toBe(200);
    const hers = cookiesFrom(elsewhere);
    const herWorkspace = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { cookie: hers, "content-type": "application/json", origin: base },
      body: JSON.stringify({ name: `Dawn's own ${stamp}` }),
    });
    expect(herWorkspace.status).toBe(201);
    const me = (await (
      await fetch(`${base}/api/me`, { headers: { cookie: hers, origin: base } })
    ).json()) as { handle: string };
    expect(me.handle).toBe("dawn");

    // Robin's workspace already has the Nest, Dawn included, and it went in after she signed up.
    const bots = (await call(`/api/workspaces/${ws}/bots`)) as {
      body: { bots: { handle: string }[] };
    };
    expect(bots.body.bots.map((one) => one.handle)).toContain("dawn");

    // And a fresh workspace can still install the whole roster.
    const another = (await call("/api/workspaces", {
      method: "POST",
      json: { name: `Another nest ${stamp}` },
    })) as { body: { id: string } };
    const installed = (await call(`/api/workspaces/${another.body.id}/nest`, {
      method: "POST",
      json: {},
    })) as { status: number; text: string; body: { installed: { handle: string }[] } };
    expect(installed.status, installed.text).toBe(201);
    expect(installed.body.installed.map((one) => one.handle)).toContain("dawn");
  }, 60_000);

  test("the acceptance: a Nest agent posts via the Bot API on a granted Supabase connection", async () => {
    const botId = kimi?.bot_id ?? "";
    const botToken = kimi?.token ?? "";
    expect(botId && botToken).toBeTruthy();

    // An admin adds the workspace's Supabase connection and grants it to Kimi, read-only tools
    // only. Nothing about installing the Nest did this: a grant is a decision (spec §3.5).
    const connection = (await call(`/api/workspaces/${ws}/connections`, {
      method: "POST",
      json: {
        kind: "token",
        provider: "supabase",
        owner_type: "workspace",
        token: PAT,
        api_base: upstreamUrl,
        mcp_url: `${upstreamUrl}/mcp`,
      },
    })) as { status: number; text: string; body: { id: string } };
    expect(connection.status, connection.text).toBe(201);
    const connectionId = connection.body.id;

    // Before the grant, the agent cannot reach it at all.
    const early = await fetch(`${base}/api/bot/tools.call`, {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
      body: JSON.stringify({ connection_id: connectionId, tool: "execute_sql", args: {} }),
    });
    expect(early.status).toBe(403);
    expect(called).toEqual([]);

    const granted = await call(`/api/workspaces/${ws}/connections/${connectionId}/grants`, {
      method: "POST",
      json: {
        subject_type: "bot",
        subject_id: botId,
        allowed_tools: ["list_tables", "execute_sql"],
      },
    });
    expect(granted.status, granted.text).toBe(201);
    expect(
      (
        await call(`/api/workspaces/${ws}/bots/${botId}/install`, {
          method: "POST",
          json: { channel_id: channelId },
        })
      ).status,
    ).toBe(200);

    // And now the agent itself, over the Bot API and nothing else — the way something running
    // outside Perch would do it.
    const bot = new PerchBot({ url: base, token: botToken });
    const answer = await bot.tools.call({
      connection_id: connectionId,
      tool: "execute_sql",
      args: { query: "select count(*) from signups where week = current_week" },
    });
    expect(called).toEqual([
      {
        name: "execute_sql",
        args: { query: "select count(*) from signups where week = current_week" },
      },
    ]);
    const said = JSON.stringify(answer);
    expect(said).toContain("signups_last_week = 412");

    const posted = await bot.chat.postMessage({
      channel: channelId,
      text: `412 signups last week, from Supabase.`,
    });
    expect(posted.ts).toMatch(/\S/);

    // It landed in the channel as the bot, and everybody in it can see it.
    const messages = (await call(`/api/workspaces/${ws}/channels/${channelId}/messages`)) as {
      body: { messages: { author_type: string; author_id: string; blocks: { text?: string }[] }[] };
    };
    const mine = messages.body.messages.find(
      (one) => one.author_type === "bot" && one.author_id === botId,
    );
    expect(mine?.blocks[0]?.text).toContain("412 signups last week");

    // The invariant (AGENTS.md §1.6): Supabase saw its own credential, and nothing the agent
    // touched ever carried it.
    const upstreamCalls = seen.filter((one) => one.path === "/mcp");
    expect(upstreamCalls.length).toBeGreaterThan(0);
    for (const request of upstreamCalls) expect(request.auth).toBe(`Bearer ${PAT}`);
    expect(said).not.toContain(PAT);
    expect(said).not.toContain("sbp_");
    expect(JSON.stringify(messages.body)).not.toContain(PAT);
  }, 60_000);
});
