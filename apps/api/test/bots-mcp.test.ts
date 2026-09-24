import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Booted } from "../src/boot.ts";
import { insertBotToolCall } from "../src/repos/bots.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.6 (spec §5.3 "MCP attach (any MCP server)", §3.5 "tool marked requires_permission returns
 * pending + inbox item, completes on approval").
 *
 * The acceptance §11 names is the first test: a bot calls a tool on an attached MCP server, and
 * the credential never reaches its context. Both halves are checked against what actually went
 * over the wire — every message the model was sent, and every authorization header the provider
 * was shown — rather than against an assertion about how the code is written.
 *
 * The second test is the other half of the spec line: a tool the grant marks
 * `requires_permission` does not run when the model asks for it. It parks as a card in the thread
 * and an item in somebody's inbox, and runs when they say yes.
 *
 * Both stand-ins are real servers on this machine: an MCP server behind a token, and an
 * OpenAI-compatible endpoint that answers with tool calls. Nothing here is mocked at a seam Perch
 * owns, so the lane under test is the whole one.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let upstream: ReturnType<typeof Bun.serve> | null = null;
let upstreamUrl = "";
let model: ReturnType<typeof Bun.serve> | null = null;
let modelUrl = "";

/** The provider's credential. It must reach the stand-in and nothing else. */
const PAT = "github_pat_11ABCDE0000botattach0000wxyz";

/** Every authorization header the provider was shown. */
const seen: { path: string; auth: string | null }[] = [];
/** The tools the provider was actually asked to run, with what they were given. */
const called: { name: string; args: unknown }[] = [];
/** Every message the model was sent, which is the bot's context as the model saw it. */
const asked: string[] = [];
/** What the model does next, popped one per completion so a turn can call a tool then talk. */
let script: ({ text: string } | { tool: string; args: unknown })[] = [];

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
    called.push({ name: request.params.name, args: request.params.arguments });
    const said =
      request.params.name === "list_issues"
        ? `#1 flaky test in ${String(request.params.arguments?.repo ?? "?")}`
        : `opened #2 ${String(request.params.arguments?.title ?? "?")}`;
    return { content: [{ type: "text" as const, text: said }] };
  });
  return server;
}

/** One OpenAI streaming completion: either text, or a call to a tool. */
function completion(step: { text: string } | { tool: string; args: unknown }): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) =>
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
      const head = { id: "1", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      if ("text" in step) {
        for (const delta of step.text.match(/.{1,8}/g) ?? [""]) {
          send({
            ...head,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          });
        }
      } else {
        send({
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
                    function: { name: step.tool, arguments: JSON.stringify(step.args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      }
      send({
        ...head,
        choices: [{ index: 0, delta: {}, finish_reason: "text" in step ? "stop" : "tool_calls" }],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      });
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const auth = request.headers.get("authorization");
      seen.push({ path: url.pathname, auth });
      if (url.pathname === "/user") {
        if (auth !== `Bearer ${PAT}`) return Response.json({ message: "no" }, { status: 401 });
        return Response.json({ login: "octocat" });
      }
      if (url.pathname !== "/mcp") return Response.json({ message: "no" }, { status: 404 });
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

  model = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "stub-1" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("no", { status: 404 });
      const body = (await request.json()) as {
        messages: unknown[];
        tools?: { function?: { name?: string } }[];
      };
      asked.push(JSON.stringify(body));
      return completion(script.shift() ?? { text: "Nothing to add." });
    },
  });
  modelUrl = `http://127.0.0.1:${model.port}/v1`;

  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  upstream?.stop(true);
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
  author_id: string;
  thread_root_id: string | null;
  blocks: { type: string; id?: string; text?: string; action?: string; decision?: string }[];
};

let ws = "";
let channel = "";
let connectionId = "";
let botId = "";
let robin = { cookie: "", id: "" };

const say = (text: string) =>
  call(`/api/workspaces/${ws}/channels/${channel}/messages`, robin.cookie, {
    method: "POST",
    json: { text },
  }) as Promise<{ status: number; body: MessageBody }>;

const thread = async (rootId: string) => {
  const res = (await call(`/api/workspaces/${ws}/messages/${rootId}/thread`, robin.cookie)) as {
    body: { messages: MessageBody[] };
  };
  return res.body.messages;
};

describe("MCP attach for bots (task 3.6)", () => {
  test("a bot is given a workspace connection, narrowed by its grant", async () => {
    const stamp = Date.now();
    robin = await signUp("Robin", `robin-attach-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", robin.cookie, {
      method: "POST",
      json: { name: "Attach Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const room = (await call(`/api/workspaces/${ws}/channels`, robin.cookie, {
      method: "POST",
      json: { type: "public", name: "newsroom" },
    })) as { body: { id: string } };
    channel = room.body.id;

    // A shared bot runs on a workspace connection, never on somebody's personal one (§1.6).
    const connected = (await call(`/api/workspaces/${ws}/connections`, robin.cookie, {
      method: "POST",
      json: {
        kind: "token",
        provider: "github",
        owner_type: "workspace",
        token: PAT,
        api_base: upstreamUrl,
        mcp_url: `${upstreamUrl}/mcp`,
      },
    })) as { status: number; body: { id: string; account: string | null } };
    expect(connected.status).toBe(201);
    connectionId = connected.body.id;

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
    expect(
      (
        await call(`/api/workspaces/${ws}/model-profiles`, robin.cookie, {
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

    const bot = (await call(`/api/workspaces/${ws}/bots`, robin.cookie, {
      method: "POST",
      json: {
        handle: "scout",
        name: "Scout",
        visibility: "workspace",
        spec: {
          persona: "You look things up.",
          brain: { profile: "Stub brain" },
          triggers: [{ on: "mention" }],
          tools: [],
          mcp: [{ connection: connectionId }],
        },
        budget: { dailyUsd: 5 },
      },
    })) as { status: number; body: { id: string } };
    expect(bot.status).toBe(201);
    botId = bot.body.id;
    expect(
      (
        await call(`/api/workspaces/${ws}/bots/${botId}/install`, robin.cookie, {
          method: "POST",
          json: { channel_id: channel },
        })
      ).status,
    ).toBe(200);

    // The grant is what decides: both tools are reachable, and one of them needs a person.
    const grant = (await call(
      `/api/workspaces/${ws}/connections/${connectionId}/grants`,
      robin.cookie,
      {
        method: "POST",
        json: {
          subject_type: "bot",
          subject_id: botId,
          allowed_tools: ["list_issues", "create_issue"],
          requires_permission: ["create_issue"],
        },
      },
    )) as { status: number; body: { requires_permission: string[] | null } };
    expect(grant.status).toBe(201);
    expect(grant.body.requires_permission).toEqual(["create_issue"]);
  }, 60_000);

  test("the bot calls a tool on the attached server, and the credential never reaches it", async () => {
    asked.length = 0;
    called.length = 0;
    seen.length = 0;
    script = [
      { tool: "mcp__github__list_issues", args: { repo: "o/r" } },
      { text: "There is one open issue: a flaky test." },
    ];
    const question = await say("<@scout> what is open on o/r?");
    expect(question.status).toBe(201);
    await booted.bots.settled();

    // The acceptance: the tool ran on the provider, with what the model asked for.
    expect(called).toEqual([{ name: "list_issues", args: { repo: "o/r" } }]);
    const replies = (await thread(question.body.id)).filter((row) => row.author_type === "bot");
    expect(replies.at(-1)?.blocks[0]?.text).toContain("one open issue");

    // The invariant (AGENTS.md §1.6): the provider saw its own credential, from the api's side.
    const upstreamCalls = seen.filter((row) => row.path === "/mcp");
    expect(upstreamCalls.length).toBeGreaterThan(0);
    for (const request of upstreamCalls) expect(request.auth).toBe(`Bearer ${PAT}`);

    // And the bot's context — every message and tool definition the model was sent — never did.
    expect(asked.length).toBeGreaterThan(1);
    const context = asked.join("\n");
    expect(context).not.toContain(PAT);
    expect(context).not.toContain("github_pat_");
    // What it did see: a namespaced tool, and an answer marked as somebody else's words.
    expect(context).toContain("mcp__github__list_issues");
    expect(context).toContain("flaky test in o/r");
    expect(context).toContain("untrusted");
  }, 60_000);

  test("a tool the grant marks requires_permission waits for a person, then runs", async () => {
    asked.length = 0;
    called.length = 0;
    script = [
      { tool: "mcp__github__create_issue", args: { title: "the flaky test" } },
      { text: "I have asked somebody about that." },
    ];
    const question = await say("<@scout> open an issue about the flaky test");
    expect(question.status).toBe(201);
    await booted.bots.settled();

    // Nothing happened on the provider: it is parked.
    expect(called).toEqual([]);
    const pending = (await call(`/api/workspaces/${ws}/bot-tool-calls`, robin.cookie)) as {
      body: { calls: { id: string; tool: string; status: string; args: unknown }[] };
    };
    expect(pending.body.calls).toHaveLength(1);
    const parked = pending.body.calls[0];
    expect(parked?.tool).toBe("create_issue");
    expect(parked?.status).toBe("pending");
    expect(parked?.args).toEqual({ title: "the flaky test" });

    // The person is asked twice over: a card in the thread, and an item in their inbox.
    const posted = await thread(question.body.id);
    const card = posted.flatMap((row) => row.blocks).find((block) => block.type === "approve_deny");
    expect(card?.text).toContain("Scout wants to call github/create_issue");
    const inbox = (await call("/api/inbox?status=open", robin.cookie)) as {
      body: { items: { kind: string; ref_type: string; ref_id: string; title: string }[] };
    };
    const item = inbox.body.items.find((row) => row.ref_type === "bot_tool_call");
    expect(item?.kind).toBe("permission");
    expect(item?.ref_id).toBe(parked?.id);

    // Saying yes runs it, on the connection's own token, and the answer lands in the thread.
    const decided = (await call(
      `/api/workspaces/${ws}/bot-tool-calls/${parked?.id}/decide`,
      robin.cookie,
      { method: "POST", json: { decision: "approved" } },
    )) as { status: number; body: { status: string } };
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe("done");
    expect(called).toEqual([{ name: "create_issue", args: { title: "the flaky test" } }]);
    const after = await thread(question.body.id);
    expect(JSON.stringify(after)).toContain("opened #2 the flaky test");

    // Answered is answered: the inbox item closes, and nobody answers it twice.
    const again = await call(
      `/api/workspaces/${ws}/bot-tool-calls/${parked?.id}/decide`,
      robin.cookie,
      { method: "POST", json: { decision: "approved" } },
    );
    expect(again.status).toBe(409);
    const left = (await call("/api/inbox?status=open", robin.cookie)) as {
      body: { items: { ref_type: string }[] };
    };
    expect(left.body.items.some((row) => row.ref_type === "bot_tool_call")).toBe(false);
  }, 60_000);

  test("a tool the grant does not name is not a tool the bot has", async () => {
    // The grant is narrowed to one tool; the other is gone from the turn entirely.
    expect(
      (
        await call(`/api/workspaces/${ws}/connections/${connectionId}/grants`, robin.cookie, {
          method: "POST",
          json: {
            subject_type: "bot",
            subject_id: botId,
            allowed_tools: ["list_issues"],
          },
        })
      ).status,
    ).toBe(201);
    asked.length = 0;
    called.length = 0;
    script = [{ text: "I cannot open issues." }];
    const question = await say("<@scout> and now?");
    await booted.bots.settled();
    expect(question.status).toBe(201);
    const offered = asked.join("\n");
    expect(offered).toContain("mcp__github__list_issues");
    expect(offered).not.toContain("mcp__github__create_issue");
    expect(called).toEqual([]);
  }, 60_000);

  test("a bot's chat_post threads only under a message in the channel it posts in", async () => {
    // Code review (ADR-0176): a root from another channel would file the reply under somebody
    // else's conversation, and the chain rails would then read that thread as this one.
    const elsewhere = (await call(`/api/workspaces/${ws}/channels`, robin.cookie, {
      method: "POST",
      json: { type: "public", name: "elsewhere" },
    })) as { body: { id: string } };
    const there = (await call(
      `/api/workspaces/${ws}/channels/${elsewhere.body.id}/messages`,
      robin.cookie,
      { method: "POST", json: { text: "a thread in another room" } },
    )) as { status: number; body: MessageBody };
    expect(there.status).toBe(201);
    const herald = (await call(`/api/workspaces/${ws}/bots`, robin.cookie, {
      method: "POST",
      json: {
        handle: "herald",
        name: "Herald",
        visibility: "workspace",
        spec: {
          persona: "You announce things.",
          brain: { profile: "Stub brain" },
          triggers: [{ on: "mention" }],
          tools: ["chat_post"],
        },
      },
    })) as { status: number; body: { id: string } };
    expect(herald.status).toBe(201);
    await call(`/api/workspaces/${ws}/bots/${herald.body.id}/install`, robin.cookie, {
      method: "POST",
      json: { channel_id: channel },
    });

    asked.length = 0;
    script = [
      {
        tool: "chat_post",
        args: { channel, text: "misfiled announcement", thread_root_id: there.body.id },
      },
      { text: "That did not go through." },
    ];
    const question = await say("<@herald> announce it");
    expect(question.status).toBe(201);
    await booted.bots.settled();

    const posted = (await call(
      `/api/workspaces/${ws}/channels/${channel}/messages`,
      robin.cookie,
    )) as {
      body: { messages: MessageBody[] };
    };
    expect(JSON.stringify(posted.body)).not.toContain("misfiled announcement");
    expect(JSON.stringify(await thread(there.body.id))).not.toContain("misfiled announcement");
    // The model was told the post was refused, rather than that it happened.
    expect(asked.join("\n")).toContain("message not found");
    expect(asked.join("\n")).not.toMatch(/posted [0-9a-f]{8}-/);
  }, 60_000);

  test("a call asked in a private channel is listed only for the people in it", async () => {
    // Code review (ADR-0176): the arguments are built from the thread, so they are the thread's.
    const room = (await call(`/api/workspaces/${ws}/channels`, robin.cookie, {
      method: "POST",
      json: { type: "private", name: "legal" },
    })) as { status: number; body: { id: string } };
    expect(room.status).toBe(201);
    const parked = await insertBotToolCall(booted.db.db, {
      workspaceId: ws,
      botId,
      channelId: room.body.id,
      connectionId,
      tool: "create_issue",
      args: { title: "what the private thread said" },
    });

    const stamp = Date.now();
    const wren = await signUp("Wren", `wren-attach-${stamp}@perch.test`);
    const invite = (await call(`/api/workspaces/${ws}/invites`, robin.cookie, {
      method: "POST",
      json: { email: `wren-attach-${stamp}@perch.test`, role: "member" },
    })) as { body: { accept_url: string } };
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    expect(
      (await call(`/api/invites/${token}/accept`, wren.cookie, { method: "POST" })).status,
    ).toBe(200);

    const listed = async (cookie: string) =>
      (
        (await call(`/api/workspaces/${ws}/bot-tool-calls`, cookie)) as {
          body: { calls: { id: string }[] };
        }
      ).body.calls.map((one) => one.id);
    expect(await listed(robin.cookie)).toContain(parked.id);
    expect(await listed(wren.cookie)).not.toContain(parked.id);
  }, 60_000);
});
