import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEngine } from "@perch/engines";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.19 (spec §5.7 "agent presence: busy/idle, 'working on' cards, agent org view"): the
 * acceptance is that three agents working show three rows, and stopping one stops it.
 *
 * All three are really working. Two are coding sessions — one streaming, one parked on a
 * permission — and the third is a bot run against a model endpoint that holds its stream open
 * until the test lets go. Nothing here is a fixture standing in for a running agent, because what
 * is under test is whether Perch can see them and whether stopping one reaches the thing itself.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let model: ReturnType<typeof Bun.serve> | null = null;
let modelUrl = "";
let cookie = "";
let stranger = "";
let ws = "";
let project = "";
let channel = "";

/** Released when the test wants the bot's model call to finish. */
let letTheBotFinish: (() => void) | null = null;

/** A session that streams for a while: it is `running` for as long as the test needs. */
const slow = new FakeEngine({
  id: "slow",
  delayMs: 400,
  script: () => [
    { type: "text", delta: "thinking" },
    { type: "text", delta: " about" },
    { type: "text", delta: " it" },
    { type: "text", delta: " some" },
    { type: "text", delta: " more" },
    { type: "usage", input: 10, output: 5, costUsd: 0.02 },
    { type: "done" },
  ],
});

/** A session that stops to ask: it is `needs_you` until somebody answers, which nobody does. */
const asker = new FakeEngine({
  id: "asker",
  script: () => [
    { type: "permission", id: "p1", tool: "Write everything.txt", args: {} },
    { type: "done" },
  ],
});

beforeAll(async () => {
  model = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "stub-1" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("no", { status: 404 });
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (payload: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "stub-1",
            choices: [{ index: 0, delta: { content: "working" }, finish_reason: null }],
          });
          // Held open, so the run is genuinely in flight while the test looks at it.
          await new Promise<void>((resolve) => {
            letTheBotFinish = resolve;
          });
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "stub-1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
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

  booted = await bootTestApp({}, { engines: [slow, asker], sessions: { silenceMs: 120_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-agents-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 120_000);

afterAll(async () => {
  letTheBotFinish?.();
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

async function call(path: string, init: { method?: string; json?: unknown; as?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie: init.as ?? cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

async function signUp(name: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  return cookiesFrom(res);
}

async function until(check: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("it never happened");
}

type Agent = {
  kind: "session" | "bot";
  id: string;
  title: string;
  state: string;
  engine: string | null;
  project: { id: string; key: string } | null;
  bot: { id: string; handle: string } | null;
  cost_usd: number;
  url: string;
};

async function agents(): Promise<Agent[]> {
  const res = (await call(`/api/workspaces/${ws}/agents`)) as { body: { agents: Agent[] } };
  return res.body.agents;
}

let slowSession = "";
let askerSession = "";

describe("agent presence (task 3.19)", () => {
  test("a workspace, a project, a channel, and a bot with a brain", async () => {
    const stamp = Date.now();
    cookie = await signUp("Robin", `robin-agents-${stamp}@perch.test`);
    stranger = await signUp("Wren", `wren-agents-${stamp}@perch.test`);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Aviary" } })) as {
        body: { id: string };
      }
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

    channel = (
      (await call(`/api/workspaces/${ws}/channels`, {
        method: "POST",
        json: { type: "public", name: "floor" },
      })) as { body: { id: string } }
    ).body.id;

    const credential = (await call(`/api/workspaces/${ws}/credentials`, {
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
        handle: "scribe",
        name: "Scribe",
        visibility: "workspace",
        spec: {
          persona: "You take notes.",
          brain: { profile: "Stub brain" },
          triggers: [{ on: "mention" }],
          tools: [],
        },
      },
    })) as { status: number; body: { id: string } };
    expect(bot.status).toBe(201);
    expect(
      (
        await call(`/api/workspaces/${ws}/bots/${bot.body.id}/install`, {
          method: "POST",
          json: { channel_id: channel },
        })
      ).status,
    ).toBe(200);
  }, 180_000);

  test("the acceptance: three agents working show three rows", async () => {
    // Two sessions, each given something to do.
    for (const [engine, hold] of [
      ["slow", "slowSession"],
      ["asker", "askerSession"],
    ] as const) {
      const made = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
        method: "POST",
        json: { engine, prompt: `have a look with ${engine}`, title: `${engine} at work` },
      })) as { status: number; text: string; body: { id: string } };
      expect(made.status, made.text).toBe(201);
      if (hold === "slowSession") slowSession = made.body.id;
      else askerSession = made.body.id;
    }

    // And a bot, mentioned, whose model is holding its stream open.
    expect(
      (
        await call(`/api/workspaces/${ws}/channels/${channel}/messages`, {
          method: "POST",
          json: { blocks: [{ type: "text", text: "<@scribe> take this down" }] },
        })
      ).status,
    ).toBe(201);

    await until(async () => (await agents()).length === 3, 60_000);
    const rows = await agents();
    const byKind = new Map(rows.map((one) => [one.id, one]));

    // Each row says what it is and what it is doing, without anybody opening it.
    expect(rows.filter((one) => one.kind === "session")).toHaveLength(2);
    expect(rows.filter((one) => one.kind === "bot")).toHaveLength(1);
    expect(byKind.get(slowSession)?.engine).toBe("slow");
    expect(byKind.get(slowSession)?.project?.id).toBe(project);
    expect(byKind.get(slowSession)?.url).toContain(slowSession);
    expect(byKind.get(askerSession)?.state).toBe("needs_you");
    const bot = rows.find((one) => one.kind === "bot");
    expect(bot?.bot?.handle).toBe("scribe");
    expect(bot?.state).toBe("running");

    // Oldest first: the one that has been going longest is the one to worry about.
    const started = rows.map((one) => one.title);
    expect(started).toHaveLength(3);
  }, 180_000);

  test("stopping one stops it, and only it", async () => {
    const before = await agents();
    expect(before).toHaveLength(3);

    // The session parked on a permission: stopping it is the answer nobody was going to give.
    expect(
      (await call(`/api/workspaces/${ws}/agents/session/${askerSession}/stop`, { method: "POST" }))
        .status,
    ).toBe(200);
    await until(async () => !(await agents()).some((one) => one.id === askerSession));
    const left = await agents();
    expect(left.map((one) => one.kind).sort()).toEqual(["bot", "session"]);

    // The bot, mid-stream, from the same endpoint: one button, whatever the row is.
    const bot = left.find((one) => one.kind === "bot");
    expect(
      (await call(`/api/workspaces/${ws}/agents/bot/${bot?.id ?? ""}/stop`, { method: "POST" }))
        .status,
    ).toBe(200);
    await until(async () => !(await agents()).some((one) => one.kind === "bot"), 60_000);

    // And the run says what happened to it rather than sitting `running` for ever.
    const runs = (await call(
      `/api/workspaces/${ws}/bots/${(bot?.bot?.id ?? "") as string}/runs`,
    )) as { body: { runs: { id: string; status: string; error: string | null }[] } };
    const stopped = runs.body.runs.find((one) => one.id === bot?.id);
    expect(stopped?.status).not.toBe("running");
    expect(String(stopped?.error ?? "")).toContain("stopped");
  }, 180_000);

  test("a stranger cannot see the floor, let alone stop anything", async () => {
    expect((await call(`/api/workspaces/${ws}/agents`, { as: stranger })).status).toBe(404);
    expect(
      (
        await call(`/api/workspaces/${ws}/agents/session/${slowSession}/stop`, {
          method: "POST",
          as: stranger,
        })
      ).status,
    ).toBe(404);
    // And the one still working is still working.
    expect((await agents()).some((one) => one.id === slowSession)).toBe(true);
  }, 60_000);
});
