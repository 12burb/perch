import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { echoScript, FakeEngine } from "@perch/engines";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.12 (spec §3.5, §7.5 "Perch's own MCP server at /mcp/perch"): the acceptance is that an
 * outside agent reads a channel and opens a session through it.
 *
 * So this is an agent from outside: the MCP SDK's own client, over Streamable HTTP, holding
 * nothing but an api token. Everything it does it does through MCP — no REST call of its own —
 * and what it may do is decided by the scopes on that token, which is what §7.5 means by a grant.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let cookie = "";
let ws = "";
let channel = "";
let project = "";

const fake = new FakeEngine({ script: (turn, ctx) => echoScript(turn, ctx) });

/** A provider with an MCP server, and the credential only it should ever see. */
const PAT = "sbp_perchmcp0000000000000000000000000000";
let upstream: ReturnType<typeof Bun.serve> | null = null;
let upstreamUrl = "";
const upstreamAuth: (string | null)[] = [];

function standIn(): Server {
  const server = new Server({ name: "stand-in", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "execute_sql",
        description: "Run a read-only query",
        inputSchema: { type: "object" as const, properties: { query: { type: "string" } } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text" as const, text: "failed_migrations = 1" }],
  }));
  return server;
}

beforeAll(async () => {
  booted = await bootTestApp({}, { engines: [fake], sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-mcp-perch-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const auth = request.headers.get("authorization");
      if (url.pathname === "/v1/projects") {
        if (auth !== `Bearer ${PAT}`) return Response.json({ message: "no" }, { status: 401 });
        return Response.json([{ id: "proj", name: "The Site" }]);
      }
      if (url.pathname !== "/mcp") return Response.json({ message: "no" }, { status: 404 });
      upstreamAuth.push(auth);
      if (auth !== `Bearer ${PAT}`) return Response.json({ message: "no" }, { status: 401 });
      const server = standIn();
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  });
  upstreamUrl = `http://127.0.0.1:${upstream.port}`;
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  upstream?.stop(true);
  rmSync(projectsDir, { recursive: true, force: true });
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

/** An agent outside Perch: an MCP client, an api token, and nothing else. */
async function agent(token: string): Promise<Client> {
  const client = new Client({ name: "an-outside-agent", version: "1" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp/perch`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** What a tool said, as text: MCP answers in content blocks, and these all carry JSON. */
function said(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((one) => one.text ?? "").join("");
}

function parsed<T>(result: unknown): T {
  if ((result as { isError?: boolean }).isError)
    throw new Error(`the tool refused: ${said(result)}`);
  return JSON.parse(said(result)) as T;
}

/** Waits for a project to finish being set up; `sessions.open` refuses one that has not. */
async function ready(id: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  let status = "";
  while (Date.now() < deadline) {
    const got = (await call(`/api/workspaces/${ws}/projects/${id}`)) as {
      body: { status?: string };
    };
    status = got.body.status ?? "";
    if (status === "ready") return;
    if (status === "error") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the project never became ready (status: ${status || "unknown"})`);
}

async function tokenWith(scopes: string[]): Promise<string> {
  const made = (await call("/api/me/tokens", {
    method: "POST",
    json: { name: `agent-${scopes.join("-")}`, scopes, workspace_id: ws },
  })) as { status: number; text: string; body: { token: string } };
  expect(made.status, made.text).toBe(201);
  return made.body.token;
}

describe("Perch as an MCP server (task 3.12)", () => {
  test("a workspace with something in it to read", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-mcp-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    const made = (await call("/api/workspaces", {
      method: "POST",
      json: { name: "Outside" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const room = (await call(`/api/workspaces/${ws}/channels`, {
      method: "POST",
      json: { type: "public", name: "deploys" },
    })) as { body: { id: string } };
    channel = room.body.id;
    const repo = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "the-site" },
    })) as { status: number; text: string; body: { id: string } };
    expect(repo.status, repo.text).toBe(201);
    project = repo.body.id;
    // A project is provisioned after the request returns, and a session refuses one that is still
    // being set up — on a slow machine that is a real wait, not an instant.
    await ready(project);

    expect(
      (
        await call(`/api/workspaces/${ws}/channels/${channel}/messages`, {
          method: "POST",
          json: { text: "the nightly deploy failed on the migration step" },
        })
      ).status,
    ).toBe(201);
  }, 60_000);

  test("the acceptance: an outside agent reads a channel and opens a session through it", async () => {
    const token = await tokenWith(["chat:read", "chat:write", "sessions:open"]);
    const client = await agent(token);
    try {
      // It finds the room by asking, not by being told.
      const rooms = parsed<{ channels: { id: string; name: string; workspace_id: string }[] }>(
        await client.callTool({ name: "channels.list", arguments: {} }),
      );
      const deploys = rooms.channels.find((one) => one.name === "deploys");
      expect(deploys).toMatchObject({ id: channel, workspace_id: ws });

      // And reads it.
      const found = parsed<{ messages: { text: string; channel_id: string }[] }>(
        await client.callTool({ name: "messages.search", arguments: { query: "migration" } }),
      );
      expect(found.messages[0]?.text).toContain("the nightly deploy failed");
      expect(found.messages[0]?.channel_id).toBe(channel);

      // Then opens a session on the project to go and look at it.
      const opened = parsed<{ session_id: string; status: string; url: string }>(
        await client.callTool({
          name: "sessions.open",
          arguments: { project, prompt: "find out why the migration step failed", engine: "fake" },
        }),
      );
      expect(opened.session_id).toMatch(/\S/);
      expect(opened.url).toContain(opened.session_id);

      // And says in the channel what it is doing, in the thread the report was in.
      const posted = parsed<{ message_id: string }>(
        await client.callTool({
          name: "messages.post",
          arguments: { channel, text: "Looking at the migration now." },
        }),
      );
      expect(posted.message_id).toMatch(/\S/);
    } finally {
      await client.close();
    }

    // All of it is real: the session belongs to the project, and the message is in the channel
    // for everybody, posted as the person whose token it was.
    const sessions = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`)) as {
      body: { sessions: { id: string; status: string }[] };
    };
    expect(sessions.body.sessions).toHaveLength(1);
    const posted = (await call(`/api/workspaces/${ws}/channels/${channel}/messages`)) as {
      body: { messages: { author_type: string; blocks: { text?: string }[] }[] };
    };
    const mine = posted.body.messages.find((one) =>
      (one.blocks[0]?.text ?? "").includes("Looking at the migration"),
    );
    expect(mine?.author_type).toBe("user");
  }, 60_000);

  test("the token's scopes are the grant: what it may not do it is not even shown", async () => {
    const token = await tokenWith(["chat:read"]);
    const client = await agent(token);
    try {
      const names = (await client.listTools()).tools.map((one) => one.name).sort();
      // Read the chat, and nothing else — no posting, no sessions, no connections.
      expect(names).toEqual(["channels.list", "messages.search"]);

      const refused = await client.callTool({
        name: "messages.post",
        arguments: { channel, text: "let me in" },
      });
      expect(refused.isError).toBe(true);
      expect(said(refused)).toContain("chat:write");
    } finally {
      await client.close();
    }

    // Nothing was posted by the attempt.
    const posted = (await call(`/api/workspaces/${ws}/channels/${channel}/messages`)) as {
      body: { messages: { blocks: { text?: string }[] }[] };
    };
    expect(JSON.stringify(posted.body)).not.toContain("let me in");
  }, 60_000);

  test("connections.call reaches the provider, and the credential stays behind", async () => {
    // A workspace connection, made the ordinary way by somebody who may.
    const made = (await call(`/api/workspaces/${ws}/connections`, {
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
    expect(made.status, made.text).toBe(201);

    const token = await tokenWith(["tools:call"]);
    const client = await agent(token);
    let answer = "";
    try {
      expect((await client.listTools()).tools.map((one) => one.name)).toEqual(["connections.call"]);
      answer = said(
        await client.callTool({
          name: "connections.call",
          arguments: {
            connection: made.body.id,
            tool: "execute_sql",
            args: { query: "select count(*) from migrations where failed" },
          },
        }),
      );
    } finally {
      await client.close();
    }
    expect(answer).toContain("failed_migrations = 1");

    // The invariant (AGENTS.md §1.6): the provider saw its own credential, the agent saw none.
    expect(upstreamAuth.length).toBeGreaterThan(0);
    for (const seen of upstreamAuth) expect(seen).toBe(`Bearer ${PAT}`);
    expect(answer).not.toContain(PAT);
    expect(answer).not.toContain("sbp_");
  }, 60_000);

  test("work.create and work.update: an agent puts something on the board and moves it", async () => {
    const token = await tokenWith(["work:write"]);
    const client = await agent(token);
    try {
      expect((await client.listTools()).tools.map((one) => one.name).sort()).toEqual([
        "work.create",
        "work.update",
      ]);
      const made = parsed<{ id: string; identifier: string; state: string; title: string }>(
        await client.callTool({
          name: "work.create",
          arguments: {
            project,
            title: "The migration step needs a retry",
            description: "It fails on a cold database.",
            type: "bug",
            priority: 1,
          },
        }),
      );
      expect(made.identifier).toMatch(/-1$/);
      expect(made.state).toBe("backlog");

      // And it can move it, by the `KEY-123` a person would have said rather than by a uuid.
      const moved = parsed<{ state: string; pr_url: string | null }>(
        await client.callTool({
          name: "work.update",
          arguments: {
            item: made.identifier,
            state: "in_review",
            pr_url: "https://github.com/acme/site/pull/12",
          },
        }),
      );
      expect(moved.state).toBe("in_review");
      expect(moved.pr_url).toBe("https://github.com/acme/site/pull/12");

      // Somebody else's item is not there to move.
      const refused = await client.callTool({
        name: "work.update",
        arguments: { item: "NOPE-1", state: "done" },
      });
      expect(refused.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);

  test("no token is a challenge, not a page", async () => {
    const res = await fetch(`${base}/mcp/perch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  }, 60_000);

  test("a token's workspace is a membership: refused for a workspace the maker is not in, and over once they leave", async () => {
    // Somebody else again, not (yet) in Robin's workspace.
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Tern",
        email: `tern-mcp-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    const mine = cookie;
    cookie = cookiesFrom(signUp);
    try {
      const tern = (await call("/api/me")) as { body: { id: string } };
      // A token bound to a workspace they are not a member of is refused when it is made …
      const refused = await call("/api/me/tokens", {
        method: "POST",
        json: { name: "tern-outside", scopes: ["chat:read"], workspace_id: ws },
      });
      expect(refused.status, refused.text).toBe(403);

      // … and one made while they were a member ends when the membership does.
      cookie = mine;
      const invite = (await call(`/api/workspaces/${ws}/invites`, {
        method: "POST",
        json: { email: `tern-mcp-${stamp}@perch.test`, role: "member" },
      })) as { status: number; body: { accept_url: string } };
      expect(invite.status).toBe(201);
      const accept = invite.body.accept_url.split("/invite/")[1] ?? "";
      cookie = cookiesFrom(signUp);
      expect((await call(`/api/invites/${accept}/accept`, { method: "POST" })).status).toBe(200);
      const made = (await call("/api/me/tokens", {
        method: "POST",
        json: { name: "tern-inside", scopes: ["chat:read"], workspace_id: ws },
      })) as { status: number; text: string; body: { token: string } };
      expect(made.status, made.text).toBe(201);
      // On REST the bound token is that workspace's alone: Tern's own workspace answers it the
      // way it answers a stranger, while a token with no workspace on it is as wide as Tern.
      const elsewhere = (await call("/api/workspaces", {
        method: "POST",
        json: { name: "Tern's own" },
      })) as { status: number; body: { id: string } };
      expect(elsewhere.status).toBe(201);
      const bearer = async (token: string, path: string) =>
        (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })).status;
      expect(await bearer(made.body.token, `/api/workspaces/${ws}/channels`)).not.toBe(404);
      expect(await bearer(made.body.token, `/api/workspaces/${elsewhere.body.id}/channels`)).toBe(
        404,
      );
      const wide = (await call("/api/me/tokens", {
        method: "POST",
        json: { name: "tern-wide", scopes: ["chat:read"] },
      })) as { body: { token: string } };
      expect(
        await bearer(wide.body.token, `/api/workspaces/${elsewhere.body.id}/channels`),
      ).not.toBe(404);
      const client = await agent(made.body.token);
      try {
        const rooms = parsed<{ channels: { name: string }[] }>(
          await client.callTool({ name: "channels.list", arguments: {} }),
        );
        expect(rooms.channels.length).toBeGreaterThan(0);
      } finally {
        await client.close();
      }

      cookie = mine;
      const removed = await call(`/api/workspaces/${ws}/members/${tern.body.id}`, {
        method: "DELETE",
      });
      expect(removed.status, removed.text).toBe(204);
      // The token still exists; the workspace on it is no longer theirs, so the server says so.
      await expect(agent(made.body.token)).rejects.toThrow(/unauthorized/i);
    } finally {
      cookie = mine;
    }
  }, 60_000);

  test("a token is one person's: it sees the workspaces they are in and no others", async () => {
    // Somebody else, with their own workspace and their own channel in it.
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Wren",
        email: `wren-mcp-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    const mine = cookie;
    cookie = cookiesFrom(signUp);
    const theirs = (await call("/api/workspaces", {
      method: "POST",
      json: { name: "Elsewhere" },
    })) as { body: { id: string } };
    expect(
      (
        await call(`/api/workspaces/${theirs.body.id}/channels`, {
          method: "POST",
          json: { type: "public", name: "their-room" },
        })
      ).status,
    ).toBe(201);
    const token = await (async () => {
      const made = (await call("/api/me/tokens", {
        method: "POST",
        json: { name: "wren", scopes: ["chat:read", "sessions:open"] },
      })) as { status: number; text: string; body: { token: string } };
      expect(made.status, made.text).toBe(201);
      return made.body.token;
    })();
    cookie = mine;

    const client = await agent(token);
    try {
      const rooms = parsed<{ channels: { name: string }[] }>(
        await client.callTool({ name: "channels.list", arguments: {} }),
      );
      expect(rooms.channels.map((one) => one.name)).toEqual(["their-room"]);

      // And Robin's project is not theirs to open a session on.
      const refused = await client.callTool({
        name: "sessions.open",
        arguments: { project, prompt: "let me in", engine: "fake" },
      });
      expect(refused.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);
});
