import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.10 (spec §5.4 "orchestrator tags specialists … fan-out (parallel; wait for all/first/
 * quorum) … orchestrator collects and posts the outcome"; §5.3 "orchestrator flag").
 *
 * The acceptance is the first test: an orchestrator splits a task across three specialists and
 * posts one answer. What is new here over task 2.7's fan-out is the three things the task line
 * names — the plan card in the thread, a share of the budget for each specialist, and one folded
 * answer at the end — plus the flag itself meaning something: a bot that is not an orchestrator is
 * refused.
 *
 * The model is a stub OpenAI-compatible endpoint that answers per bot, so what a bot "decides" is
 * fixed and the orchestration is what is under test. The orchestrator's first turn calls `fan_out`
 * for real; everything after that is Perch's.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let model: ReturnType<typeof Bun.serve> | null = null;
let modelUrl = "";
let ws = "";
let channel = "";
let robin = { cookie: "", id: "" };

/** What each bot does when it is asked: text, or a call to a tool. */
type Move = { text: string } | { tool: string; args: unknown };
/** Per handle, the moves in order; the last one repeats once the list runs out. */
const MOVES = new Map<string, Move[]>();

function completion(step: Move): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) =>
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
      const head = { id: "1", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      if ("text" in step) {
        send({
          ...head,
          choices: [{ index: 0, delta: { content: step.text }, finish_reason: null }],
        });
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
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      });
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

beforeAll(async () => {
  model = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "stub-1" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("no", { status: 404 });
      const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
      const system = body.messages.find((one) => one.role === "system");
      const handle = /writing @([a-z0-9_-]+)/.exec(String(system?.content ?? ""))?.[1] ?? "";
      const moves = MOVES.get(handle) ?? [{ text: "Nothing to add." }];
      const step = moves.length > 1 ? (moves.shift() ?? moves[0]) : moves[0];
      return completion(step ?? { text: "Nothing to add." });
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
    .map((one) => one.split(";")[0] ?? "")
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

type Step = { handle: string; text: string; status: string; note?: string; budgetUsd?: number };
type Block = { type: string; text?: string; steps?: Step[] };
type MessageBody = {
  id: string;
  author_type: string;
  author_name: string | null;
  blocks: Block[];
};

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

async function makeBot(
  handle: string,
  name: string,
  extra: { orchestrator?: boolean; tools?: string[]; budget?: Record<string, number> } = {},
) {
  const made = (await call(`/api/workspaces/${ws}/bots`, robin.cookie, {
    method: "POST",
    json: {
      handle,
      name,
      visibility: "workspace",
      ...(extra.orchestrator ? { orchestrator: true } : {}),
      budget: { dailyUsd: 5, perThreadUsd: 3, ...extra.budget },
      spec: {
        persona: `You are ${name}.`,
        brain: { profile: "Stub brain" },
        triggers: [{ on: "mention" }],
        tools: extra.tools ?? [],
      },
    },
  })) as { status: number; text: string; body: { id: string } };
  expect(made.status, made.text).toBe(201);
  expect(
    (
      await call(`/api/workspaces/${ws}/bots/${made.body.id}/install`, robin.cookie, {
        method: "POST",
        json: { channel_id: channel },
      })
    ).status,
  ).toBe(200);
  return made.body.id;
}

describe("orchestrators (task 3.10)", () => {
  test("a workspace with a brain, an orchestrator and three specialists", async () => {
    const stamp = Date.now();
    robin = await signUp("Robin", `robin-orch-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", robin.cookie, {
      method: "POST",
      json: { name: "Orchestra" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const room = (await call(`/api/workspaces/${ws}/channels`, robin.cookie, {
      method: "POST",
      json: { type: "public", name: "newsroom" },
    })) as { body: { id: string } };
    channel = room.body.id;

    const credential = (await call(`/api/workspaces/${ws}/credentials`, robin.cookie, {
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
        await call(`/api/workspaces/${ws}/model-profiles`, robin.cookie, {
          method: "POST",
          json: {
            name: "Stub brain",
            provider: "custom",
            model_id: "gpt-4o-mini",
            credential_id: credential.body.id,
            default_for: "chat",
          },
        })
      ).status,
    ).toBe(201);

    await makeBot("birbus", "Birbus", { orchestrator: true, tools: ["fan_out"] });
    await makeBot("julius", "Julius");
    await makeBot("paige", "Paige");
    await makeBot("kimi", "Kimi");
    // Not an orchestrator, but asks to fan out anyway.
    await makeBot("hopeful", "Hopeful", { tools: ["fan_out"] });
  }, 60_000);

  test("the acceptance: an orchestrator splits a task across three specialists and posts one answer", async () => {
    MOVES.set("birbus", [
      {
        tool: "fan_out",
        args: {
          tasks: [
            { handle: "julius", text: "find what happened this week" },
            { handle: "paige", text: "draft the intro" },
            { handle: "kimi", text: "how many signups" },
          ],
          wait: "all",
        },
      },
      { text: "Here is the issue: Julius found the story, Paige wrote the intro, Kimi has 412." },
    ]);
    MOVES.set("julius", [{ text: "Julius: two launches and a merger." }]);
    MOVES.set("paige", [{ text: "Paige: a week that moved faster than it looked." }]);
    MOVES.set("kimi", [{ text: "Kimi: 412 signups, up 9%." }]);

    const asked = await say("<@birbus> put this week's issue together");
    expect(asked.status).toBe(201);
    await booted.bots.settled();
    const said = await thread(asked.body.id);

    // The plan card: one row per specialist, each with what it was asked and what it may spend.
    const plan = said.flatMap((row) => row.blocks).find((block) => block.type === "plan_card");
    expect(plan).toBeDefined();
    const steps = plan?.steps ?? [];
    expect(steps.map((step) => step.handle).sort()).toEqual(["julius", "kimi", "paige"]);
    expect(steps.every((step) => step.status === "done")).toBe(true);
    expect(steps.find((step) => step.handle === "kimi")?.note).toContain("412 signups");
    // The root's budget, split three ways: a third each, not first-come-first-served.
    for (const step of steps) expect(step.budgetUsd).toBeCloseTo(1, 1);

    // All three did the work, in the same thread, attributed.
    const names = said
      .filter((row) => row.author_type === "bot")
      .map((row) => row.author_name ?? "");
    expect(new Set(names)).toEqual(new Set(["Birbus", "Julius", "Paige", "Kimi"]));

    // And one answer, folded back by the orchestrator from what came back. It lands in the
    // placeholder the run opened with — above the plan and the tags, which are the working-out —
    // because that is where every bot's reply goes (spec §5.4 "edit a placeholder into the final
    // reply").
    const mine = said.filter((row) => row.author_name === "Birbus");
    const folded = mine.find((row) => (row.blocks[0]?.text ?? "").includes("Here is the issue"));
    expect(folded).toBeDefined();
    expect(folded?.blocks[0]?.text).toContain("412");
    // One answer, not three: the specialists' words are theirs, and Birbus wrote its own line.
    expect(
      mine.filter((row) => (row.blocks[0]?.text ?? "").includes("Here is the issue")),
    ).toHaveLength(1);
  }, 180_000);

  test("only an orchestrator may split a job; anybody else is told so", async () => {
    MOVES.set("hopeful", [
      {
        tool: "fan_out",
        args: { tasks: [{ handle: "julius", text: "do my job for me" }], wait: "all" },
      },
      { text: "I could not split that." },
    ]);
    MOVES.set("julius", [{ text: "Julius: this should not happen." }]);

    const asked = await say("<@hopeful> split this up");
    await booted.bots.settled();
    const said = await thread(asked.body.id);
    // No plan, and Julius was never asked: the flag is what decides, not the tool being present.
    expect(said.flatMap((row) => row.blocks).some((block) => block.type === "plan_card")).toBe(
      false,
    );
    expect(said.some((row) => row.author_name === "Julius")).toBe(false);
    expect(said.some((row) => row.author_name === "Hopeful")).toBe(true);
  }, 120_000);
});
