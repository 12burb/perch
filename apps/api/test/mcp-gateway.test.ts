import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { upsertGrant } from "../src/repos/connections.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.17 (spec §7.5): the MCP gateway. An ACP session is handed `/mcp/{connectionId}` and a
 * token Perch minted for it; the gateway attaches the connection's real credential upstream. The
 * acceptance is the one §11 names — the agent lists issues, and the provider's token never appears
 * in the runner — plus the two rules that make the proxy worth having: a grant's allow-list decides
 * what a session may call, and every call is audited whichever way it goes.
 *
 * The provider is a stand-in on this machine, reached through the connection's `api_base` and
 * `mcp_url` — the same fields a GitHub Enterprise install would use, so there is no test-only seam.
 * This environment cannot reach api.githubcopilot.com, so nothing here claims to have run against
 * GitHub's own MCP server (ADR-0083).
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let upstream: ReturnType<typeof Bun.serve> | null = null;
let upstreamUrl = "";
const fixture = join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "acp-agent.ts");

/** The provider's credential. It must reach the stand-in and nothing else. */
const PAT = "github_pat_11ABCDE0000gateway0000wxyz";

/** Every authorization header the stand-in was shown, so the test can prove what went out. */
const seen: { path: string; auth: string | null }[] = [];
/** The tools the stand-in was actually asked to run. */
const called: string[] = [];

/** The provider's MCP server: two tools, one of which the allow-list will take away. */
function upstreamServer(): Server {
  const server = new Server({ name: "stand-in", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_issues",
        description: "Issues on a repository",
        inputSchema: { type: "object" as const, properties: { repo: { type: "string" } } },
      },
      {
        name: "create_issue",
        description: "Open an issue",
        inputSchema: { type: "object" as const, properties: { title: { type: "string" } } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    called.push(request.params.name);
    const repo = String(request.params.arguments?.repo ?? "?");
    return { content: [{ type: "text" as const, text: `#1 flaky test in ${repo}` }] };
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
      if (url.pathname === "/user") {
        if (auth !== `Bearer ${PAT}`) return Response.json({ message: "no" }, { status: 401 });
        return Response.json({ login: "octocat" });
      }
      if (url.pathname !== "/mcp") return Response.json({ message: "no" }, { status: 404 });
      // The credential the gateway attaches: anything else gets nothing.
      if (auth !== `Bearer ${PAT}`) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      const server = upstreamServer();
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  });
  upstreamUrl = `http://127.0.0.1:${upstream.port}`;

  // The gateway's URL comes from PERCH_PUBLIC_URL, which is fixed at boot, so the port is chosen
  // before the app is booted and handed straight back to serve().
  const reserved = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = reserved.port;
  reserved.stop(true);

  booted = await bootTestApp(
    { PERCH_PUBLIC_URL: `http://127.0.0.1:${port}` },
    { sessions: { silenceMs: 60_000 } },
  );
  projectsDir = mkdtempSync(join(tmpdir(), "perch-mcp-"));
  booted.runners.attach(
    createInProcessRunner({
      projectsDir,
      portsIntervalMs: 0,
      sessions: {
        agents: { fake: { name: "Fake Agent", command: process.execPath, args: [fixture] } },
        defaultAgent: "fake",
      },
    }),
  );
  running = serve(booted, { port, hostname: "127.0.0.1" });
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
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function signUp(name: string, email: string) {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  return { cookie: cookiesFrom(res) };
}

async function call(path: string, cookie: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  return { status: res.status, body: (res.status === 204 ? null : await res.json()) as unknown };
}

async function readyProject(cookie: string, ws: string, name: string): Promise<string> {
  const created = (await call(`/api/workspaces/${ws}/projects`, cookie, {
    method: "POST",
    json: { name },
  })) as { body: { id: string } };
  const id = created.body.id;
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = (await call(`/api/workspaces/${ws}/projects/${id}`, cookie)) as {
      body: { status: string; status_message: string | null };
    };
    if (res.body.status === "ready") return id;
    if (res.body.status === "error" || Date.now() > deadline) {
      throw new Error(`project ${res.body.status}: ${res.body.status_message}`);
    }
    await Bun.sleep(50);
  }
}

type SessionBody = { id: string; status: string; status_message: string | null };

async function untilStatus(cookie: string, id: string, status: string): Promise<SessionBody> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = (await call(`/api/sessions/${id}`, cookie)) as { body: SessionBody };
    if (res.body.status === status) return res.body;
    if (Date.now() > deadline) {
      throw new Error(`session stayed ${res.body.status} (${res.body.status_message})`);
    }
    await Bun.sleep(25);
  }
}

type EventsBody = { events: { seq: number; event: { type: string; delta?: string } }[] };

async function transcript(cookie: string, id: string): Promise<string> {
  const replay = (await call(`/api/sessions/${id}/events`, cookie)) as { body: EventsBody };
  return replay.body.events
    .map((e) => (e.event.type === "text" ? (e.event.delta ?? "") : ""))
    .join("");
}

type AuditBody = { rows: { action: string; details: Record<string, unknown> }[] };

async function auditRows(cookie: string, ws: string): Promise<AuditBody["rows"]> {
  const res = (await call(`/api/workspaces/${ws}/audit?action=tools.called`, cookie)) as {
    body: AuditBody;
  };
  return res.body.rows;
}

/** The tool names in a `tools/list` answer. */
function toolNames(json: Record<string, unknown> | null): string[] {
  const result = json?.result as { tools?: { name: string }[] } | undefined;
  return (result?.tools ?? []).map((tool) => tool.name);
}

/** A JSON-RPC call straight at the gateway, the way a client that is not an agent would make it. */
async function rpc(
  url: string,
  token: string | null,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

describe("the MCP gateway (task 1.17)", () => {
  let ws = "";
  let cookie = "";
  let connectionId = "";
  /** The URL and token the session was given, lifted from what the agent reported. */
  let gatewayUrl = "";
  let gatewayToken = "";
  let sessionId = "";
  let userId = "";

  test("an agent lists issues through the gateway, and the token stays behind", async () => {
    const owner = await signUp("Mo", "mo-mcp@perch.test");
    cookie = owner.cookie;
    userId = ((await call("/api/me", cookie)) as { body: { id: string } }).body.id;
    const created = (await call("/api/workspaces", cookie, {
      method: "POST",
      json: { name: "Gateway Nest" },
    })) as { body: { id: string } };
    ws = created.body.id;

    const connected = (await call(`/api/workspaces/${ws}/connections`, cookie, {
      method: "POST",
      json: {
        kind: "token",
        provider: "github",
        token: PAT,
        api_base: upstreamUrl,
        mcp_url: `${upstreamUrl}/mcp`,
      },
    })) as { status: number; body: { id: string; account: string | null } };
    expect(connected.status).toBe(201);
    expect(connected.body.account).toBe("octocat");
    connectionId = connected.body.id;

    const project = await readyProject(cookie, ws, "Gateway");
    const opened = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, cookie, {
      method: "POST",
      json: { engine: "acp", model: { provider: "fake", model_id: "default" }, prompt: "tools?" },
    })) as { status: number; body: SessionBody };
    expect(opened.status).toBe(201);
    sessionId = opened.body.id;
    await untilStatus(cookie, sessionId, "idle");

    const said = await transcript(cookie, sessionId);
    // The acceptance: the agent saw the provider's tools and got its issues back.
    expect(said).toContain("mcp github tools: list_issues, create_issue");
    expect(said).toContain("mcp github issues: #1 flaky test in o/r");
    expect(called).toContain("list_issues");

    // The invariant: what the runner held was Perch's token, not the provider's (AGENTS.md §1.6).
    const bearer = /mcp github bearer: Bearer (\S+)/.exec(said)?.[1] ?? "";
    expect(bearer).not.toBe("");
    expect(bearer).not.toBe(PAT);
    expect(said).not.toContain(PAT);
    expect(said).not.toContain("github_pat_");
    gatewayToken = bearer;
    gatewayUrl = `${base}/mcp/${connectionId}`;

    // And the provider only ever saw its own credential, from the api's side of the proxy.
    const upstreamCalls = seen.filter((s) => s.path === "/mcp");
    expect(upstreamCalls.length).toBeGreaterThan(0);
    for (const request of upstreamCalls) expect(request.auth).toBe(`Bearer ${PAT}`);

    // Every call audited (spec §7.5): the tool, the caller, a hash of the arguments, the outcome.
    const rows = await auditRows(cookie, ws);
    const ok = rows.find((row) => row.details.tool === "list_issues");
    expect(ok?.details).toMatchObject({ connectionId, outcome: "ok", callerType: "user" });
    expect(String(ok?.details.argsHash)).toMatch(/^[0-9a-f]{16,}$/);
    // The hash is of the arguments, never the arguments: a repository name is the least of what a
    // tool call can carry.
    expect(JSON.stringify(rows)).not.toContain(PAT);
  }, 90_000);

  test("a grant's allow-list decides what the session may call, and a refusal is audited", async () => {
    // Both tools, while the grant names none.
    const listed = await rpc(gatewayUrl, gatewayToken, { method: "tools/list", params: {} });
    expect(listed.status).toBe(200);
    const tools = toolNames(listed.json);
    expect(tools).toEqual(["list_issues", "create_issue"]);

    await upsertGrant(booted.db.db, {
      connectionId,
      subjectType: "session",
      subjectId: sessionId,
      allowedTools: ["create_issue"],
      requiresPermission: null,
      channels: null,
      obo: true,
      grantedBy: userId,
    });

    const narrowed = await rpc(gatewayUrl, gatewayToken, { method: "tools/list", params: {} });
    const after = toolNames(narrowed.json);
    expect(after).toEqual(["create_issue"]);

    const before = called.length;
    const refused = await rpc(gatewayUrl, gatewayToken, {
      method: "tools/call",
      params: { name: "list_issues", arguments: { repo: "o/r" } },
    });
    // An MCP tool error is a result with isError, not a transport failure.
    const result = refused.json?.result as { isError?: boolean; content?: { text?: string }[] };
    const error = refused.json?.error as { message?: string } | undefined;
    expect(result?.isError === true || typeof error?.message === "string").toBe(true);
    expect(`${result?.content?.[0]?.text ?? ""}${error?.message ?? ""}`).toMatch(/list_issues/);
    // Refused before the upstream was touched: the provider never heard of this call.
    expect(called.length).toBe(before);

    const rows = await auditRows(cookie, ws);
    const denied = rows.find((row) => row.details.outcome === "denied");
    expect(denied?.details).toMatchObject({ tool: "list_issues", connectionId });
  }, 30_000);

  test("no token, no gateway", async () => {
    const res = await fetch(gatewayUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="perch"');

    // A token for a different session is a token for a different session.
    const other = await rpc(gatewayUrl, `${gatewayToken}tampered`, {
      method: "tools/list",
      params: {},
    });
    expect(other.status).toBe(401);
  }, 30_000);
});
