import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.24 (spec §3.5 "runner-local stdio MCP servers are exposed through the same shape", §7.6
 * `mcp.spawn`): a project's own tools, running where the project does.
 *
 * The acceptance §11 names is the last test: a bot calls a tool on a server running inside its own
 * project's runner. Everything here is real — a real runner spawning a real MCP server over a real
 * stream, and a stand-in model that asks for the tool by name — because what is under test is a
 * transport, and a transport with a stub in the middle is a test of the stub.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let model: ReturnType<typeof Bun.serve> | null = null;
let modelUrl = "";
/** What the model does next, popped one per completion so a turn can call a tool then talk. */
let script: ({ text: string } | { tool: string; args: unknown })[] = [];
/** Every tool list the model was offered, so the test can see what the bot was given. */
const offered: string[][] = [];

function completion(next: { text: string } | { tool: string; args: unknown }): Response {
  const head = { id: "1", object: "chat.completion.chunk", created: 1, model: "stub-1" };
  const parts: unknown[] = [];
  if ("text" in next) {
    parts.push({ ...head, choices: [{ index: 0, delta: { content: next.text } }] });
    parts.push({ ...head, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  } else {
    parts.push({
      ...head,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: next.tool, arguments: JSON.stringify(next.args) },
              },
            ],
          },
        },
      ],
    });
    parts.push({ ...head, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  }
  const body = `${parts.map((one) => `data: ${JSON.stringify(one)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

beforeAll(async () => {
  model = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "stub-1" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("no", { status: 404 });
      const body = (await request.json()) as { tools?: { function?: { name?: string } }[] };
      offered.push((body.tools ?? []).map((one) => one.function?.name ?? ""));
      return completion(script.shift() ?? { text: "Nothing to add." });
    },
  });
  modelUrl = `http://127.0.0.1:${model.port}/v1`;

  booted = await bootTestApp({});
  projectsDir = mkdtempSync(join(tmpdir(), "perch-local-mcp-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 120_000);

afterAll(async () => {
  await running.stop();
  model?.stop(true);
  rmSync(projectsDir, { recursive: true, force: true });
});

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((one) => one.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

let cookie = "";
async function call(path: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

async function until(check: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("it never happened");
}

type MessageBody = { id: string; author_type: string; blocks: { type: string; text?: string }[] };

let ws = "";
let channel = "";
let project = "";
let serverId = "";
let botId = "";

describe("MCP servers a runner hosts (task 3.24)", () => {
  test("a project, and the server it ships with its tools", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-local-mcp-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Local" } })) as {
        body: { id: string };
      }
    ).body.id;
    channel = (
      (await call(`/api/workspaces/${ws}/channels`, {
        method: "POST",
        json: { name: "tools", type: "public" },
      })) as { body: { id: string } }
    ).body.id;
    const made = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "the-site", source: "empty", default_branch: "main" },
    })) as { status: number; text: string; body: { id: string } };
    expect(made.status, made.text).toBe(201);
    project = made.body.id;
    await until(async () => {
      const row = (await call(`/api/workspaces/${ws}/projects/${project}`)) as {
        body: { status: string };
      };
      return row.body.status === "ready";
    }, 60_000);

    // The row that stands for a server the runner starts: a command, not a URL and not a token.
    const written = (await call(`/api/workspaces/${ws}/mcp-servers`, {
      method: "POST",
      json: {
        name: "project-tools",
        project_id: project,
        command: process.execPath,
        args: [join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "stdio-mcp.ts")],
      },
    })) as { status: number; text: string; body: { id: string; transport: string } };
    expect(written.status, written.text).toBe(201);
    expect(written.body.transport).toBe("stdio");
    serverId = written.body.id;

    const listed = (await call(`/api/workspaces/${ws}/mcp-servers?project=${project}`)) as {
      body: { servers: { id: string; name: string }[] };
    };
    expect(listed.body.servers.map((one) => one.name)).toEqual(["project-tools"]);
  }, 180_000);

  test("the acceptance: a bot calls a tool on a server inside its own project's runner", async () => {
    const credential = (await call(`/api/workspaces/${ws}/credentials`, {
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
        await call(`/api/workspaces/${ws}/model-profiles`, {
          method: "POST",
          json: {
            name: "Stub brain",
            provider: "custom",
            model_id: "stub-1",
            credential_id: credential.body.id,
            default_for: "chat",
          },
        })
      ).status,
    ).toBe(201);

    const bot = (await call(`/api/workspaces/${ws}/bots`, {
      method: "POST",
      json: {
        handle: "tools",
        name: "Tools",
        visibility: "workspace",
        budget: { dailyUsd: 5 },
        spec: {
          persona: "You use the project's own tools.",
          brain: { profile: "Stub brain" },
          triggers: [{ on: "mention" }],
          tools: [],
          // Named by the row's id, the way a connection is named (spec §5.3).
          mcp: [{ connection: serverId }],
        },
      },
    })) as { status: number; text: string; body: { id: string } };
    expect(bot.status, bot.text).toBe(201);
    botId = bot.body.id;
    expect(
      (
        await call(`/api/workspaces/${ws}/bots/${botId}/install`, {
          method: "POST",
          json: { channel_id: channel },
        })
      ).status,
    ).toBe(200);

    // It calls the tool, is shown what it said, and answers with it.
    script = [
      { tool: "mcp__project-tools__echo", args: { text: "the runner's own" } },
      { text: "The project's tools say it." },
    ];
    const asked = (await call(`/api/workspaces/${ws}/channels/${channel}/messages`, {
      method: "POST",
      json: { text: "<@tools> echo something for me" },
    })) as { status: number; body: MessageBody };
    expect(asked.status).toBe(201);
    await booted.bots.settled();

    const thread = (await call(`/api/workspaces/${ws}/messages/${asked.body.id}/thread`)) as {
      body: { messages: MessageBody[] };
    };
    const answer = thread.body.messages.find((one) => one.author_type === "bot");
    expect(answer?.blocks[0]?.text).toContain("The project's tools say it.");

    // The bot was offered the server's tools, named for the server it is on.
    expect(offered.flat()).toContain("mcp__project-tools__echo");

    // And what it called is on the audit, as a call on this server rather than a connection.
    const audit = (await call(`/api/workspaces/${ws}/audit?action=tools.called`)) as {
      body: { rows: { details: Record<string, unknown> }[] };
    };
    const row = audit.body.rows.find((one) => one.details.tool === "echo");
    expect(row?.details).toMatchObject({ mcpServerId: serverId, outcome: "ok" });
  }, 300_000);

  test("it is reachable at /mcp/{id}, like any other server", async () => {
    // An api token, because a server with no credential has none to delegate: what an outside
    // agent holds is its own.
    const minted = (await call("/api/me/tokens", {
      method: "POST",
      json: { name: "outside-agent", scopes: ["chat:read"], workspace_id: ws },
    })) as { status: number; text: string; body: { token: string } };
    expect(minted.status, minted.text).toBe(201);
    const res = await fetch(`${base}/mcp/${serverId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${minted.body.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        origin: base,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).toContain("echo");
    expect(text).toContain("where");
  }, 120_000);

  test("an id of a shape no connection or server has is not found, not a database error", async () => {
    const minted = (await call("/api/me/tokens", {
      method: "POST",
      json: { name: "outside-agent-2", scopes: ["chat:read"], workspace_id: ws },
    })) as { status: number; text: string; body: { token: string } };
    expect(minted.status, minted.text).toBe(201);
    for (const id of ["not-an-id", "perch-tools", "..", "00000000-0000-0000-0000-00000000000g"]) {
      const res = await fetch(`${base}/mcp/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${minted.body.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          origin: base,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const text = await res.text();
      expect(res.status, `${id}: ${text}`).toBe(404);
      expect(JSON.parse(text)).toMatchObject({ error: { code: "not_found" } });
    }
  }, 60_000);
});
