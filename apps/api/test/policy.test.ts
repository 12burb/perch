import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@perch/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Booted } from "../src/boot.ts";
import { savePolicy } from "../src/repos/policy.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { capped } from "../src/services/bots.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.11 (spec §5.7 policy engine, §7.1 `.../policy`, `.../policy/evaluate`). The acceptance is
 * here twice over: a channel pinned to local models refuses a cloud profile — the bot says so in
 * the channel rather than answering — and `git push --force` is refused by the dry run, which is
 * the same evaluator every enforcement point asks.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let model: ReturnType<typeof Bun.serve> | null = null;
let modelUrl = "";

beforeAll(async () => {
  model = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "stub-1" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("no", { status: 404 });
      await request.json();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "stub-1",
            choices: [{ index: 0, delta: { content: "Here you go." }, finish_reason: null }],
          });
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "stub-1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
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

type Decision = { allow: boolean; rule: string | null; reason: string | null };
type MessageBody = { id: string; author_type: string; blocks: { text?: string }[] };

const POLICY = `
version: 1
git:
  protectedBranches: [main]
commands:
  deny: ["git push --force"]
models:
  channels:
    local-only:
      allow: ["ollama/*"]
budgets:
  dailyUsd: 3
`;

describe("the policy engine (task 2.11)", () => {
  let ada = { cookie: "", id: "" };
  let bo = { cookie: "", id: "" };
  let ws = "";
  let pinned = "";
  let open = "";
  let botId = "";

  const evaluate = async (request: unknown): Promise<Decision> => {
    const res = (await call(`/api/workspaces/${ws}/policy/evaluate`, ada.cookie, {
      method: "POST",
      json: { request },
    })) as { status: number; body: Decision };
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    const stamp = Date.now();
    ada = await signUp("Ada", `ada-policy-${stamp}@perch.test`);
    bo = await signUp("Bo", `bo-policy-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", ada.cookie, {
      method: "POST",
      json: { name: "Policy Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, ada.cookie, {
      method: "POST",
      json: { email: `bo-policy-${stamp}@perch.test`, role: "member" },
    })) as { body: { accept_url: string } };
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    await call(`/api/invites/${token}/accept`, bo.cookie, { method: "POST" });

    for (const name of ["local-only", "open-house"]) {
      const room = (await call(`/api/workspaces/${ws}/channels`, ada.cookie, {
        method: "POST",
        json: { type: "public", name },
      })) as { body: { id: string } };
      if (name === "local-only") pinned = room.body.id;
      else open = room.body.id;
    }

    const credential = (await call(`/api/workspaces/${ws}/credentials`, ada.cookie, {
      method: "POST",
      json: {
        provider: "custom",
        kind: "endpoint",
        scope: "workspace",
        label: "Stub",
        base_url: modelUrl,
      },
    })) as { body: { id: string } };
    await call(`/api/workspaces/${ws}/model-profiles`, ada.cookie, {
      method: "POST",
      json: {
        name: "Cloudy",
        provider: "custom",
        model_id: "stub-1",
        credential_id: credential.body.id,
        default_for: "chat",
      },
    });
    const bot = (await call(`/api/workspaces/${ws}/bots`, ada.cookie, {
      method: "POST",
      json: {
        handle: "scribe",
        name: "Scribe",
        visibility: "workspace",
        spec: { brain: { profile: "Cloudy" }, triggers: [{ on: "mention" }], tools: [] },
        budget: { dailyUsd: 5 },
      },
    })) as { body: { id: string } };
    botId = bot.body.id;
    for (const channel of [pinned, open]) {
      await call(`/api/workspaces/${ws}/bots/${botId}/install`, ada.cookie, {
        method: "POST",
        json: { channel_id: channel },
      });
    }
  }, 90_000);

  test("a workspace with nothing written down allows everything", async () => {
    expect(await evaluate({ kind: "exec", command: "git push --force" })).toMatchObject({
      allow: true,
    });
    const empty = (await call(`/api/workspaces/${ws}/policy`, ada.cookie)) as {
      status: number;
      body: { yaml: string; rules: Record<string, unknown> };
    };
    expect(empty.status).toBe(200);
    expect(empty.body.yaml).toBe("");
    expect(empty.body.rules).toEqual({});
  }, 30_000);

  test("an admin writes the policy; a member may read it but not write it", async () => {
    const refused = await call(`/api/workspaces/${ws}/policy`, bo.cookie, {
      method: "PUT",
      json: { yaml: POLICY },
    });
    expect(refused.status).toBe(403);

    const written = (await call(`/api/workspaces/${ws}/policy`, ada.cookie, {
      method: "PUT",
      json: { yaml: POLICY },
    })) as { status: number; body: { rules: { git?: { protectedBranches?: string[] } } } };
    expect(written.status).toBe(200);
    expect(written.body.rules.git?.protectedBranches).toEqual(["main"]);

    const read = (await call(`/api/workspaces/${ws}/policy`, bo.cookie)) as {
      status: number;
      body: { yaml: string };
    };
    expect(read.status).toBe(200);
    expect(read.body.yaml).toContain("protectedBranches");

    // A document that will not parse is refused rather than stored half-understood.
    const broken = await call(`/api/workspaces/${ws}/policy`, ada.cookie, {
      method: "PUT",
      json: { yaml: "models: [not, an, object]" },
    });
    expect(broken.status).toBe(422);
  }, 30_000);

  test("the dry run answers for every rule, and says which one refused", async () => {
    expect(await evaluate({ kind: "exec", command: "git push --force origin main" })).toMatchObject(
      {
        allow: false,
        rule: "commands.deny",
      },
    );
    expect(await evaluate({ kind: "exec", command: "bun test" })).toMatchObject({ allow: true });
    expect(await evaluate({ kind: "git.push", branch: "main" })).toMatchObject({
      allow: false,
      rule: "git.protectedBranches",
    });
    expect(await evaluate({ kind: "git.push", branch: "topic" })).toMatchObject({ allow: true });
    expect(
      await evaluate({ kind: "model", ref: "custom/stub-1", channel: "local-only" }),
    ).toMatchObject({ allow: false, rule: "models.channels.local-only.allow" });
    expect(
      await evaluate({ kind: "model", ref: "ollama/llama3.2", channel: "local-only" }),
    ).toMatchObject({ allow: true });
    expect(await evaluate({ kind: "budget", of: "dailyUsd", usd: 9 })).toMatchObject({
      allow: false,
      rule: "budgets.dailyUsd",
    });
  }, 30_000);

  test("two first saves at once leave one document, and the later save is the one kept", async () => {
    // A double-submitted first save used to insert two rows, and enforcement read whichever
    // came back first (ADR-0175). Both saves start before either has written anything.
    const made = (await call("/api/workspaces", ada.cookie, {
      method: "POST",
      json: { name: "Race Nest" },
    })) as { body: { id: string } };
    const raced = made.body.id;
    const documents = ['commands:\n  deny: ["rm -rf /"]\n', "budgets:\n  dailyUsd: 7\n"];
    const saved = await Promise.all(
      documents.map((yaml) =>
        savePolicy(booted.db.db, { workspaceId: raced }, { yaml, rules: {}, userId: ada.id }),
      ),
    );
    expect(saved.map((row) => row?.version).sort()).toEqual([1, 2]);
    const rows = await booted.db.db
      .select()
      .from(schema.policies)
      .where(and(eq(schema.policies.workspaceId, raced), isNull(schema.policies.projectId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(2);
    const read = (await call(`/api/workspaces/${raced}/policy`, ada.cookie)) as {
      body: { yaml: string };
    };
    expect(documents).toContain(read.body.yaml);
    expect(read.body.yaml).toBe(rows[0]?.yaml ?? "");
    // An empty document still takes the row away.
    await call(`/api/workspaces/${raced}/policy`, ada.cookie, {
      method: "PUT",
      json: { yaml: "" },
    });
    const gone = await booted.db.db
      .select()
      .from(schema.policies)
      .where(eq(schema.policies.workspaceId, raced));
    expect(gone).toHaveLength(0);
  }, 30_000);

  test("a ceiling narrows a bot's own budget, and the rails narrow its hops", async () => {
    // $3 a day is the workspace's ceiling; the bot asked for $5, so $3 is what it gets.
    const tight = (await call(`/api/workspaces/${ws}/policy/evaluate`, ada.cookie, {
      method: "POST",
      json: { request: { kind: "budget", of: "dailyUsd", usd: 5 } },
    })) as { body: Decision };
    expect(tight.body).toMatchObject({ allow: false, rule: "budgets.dailyUsd" });
    expect(capped({ dailyUsd: 5, maxHops: 6 }, { dailyUsd: 3 })).toMatchObject({ dailyUsd: 3 });
    expect(capped({ dailyUsd: 1 }, { dailyUsd: 3 })).toMatchObject({ dailyUsd: 1 });
    expect(capped({ perRunUsd: 2 }, undefined)).toMatchObject({ perRunUsd: 2 });
  }, 30_000);

  test("a channel pinned to local models refuses a cloud profile, and says so where it was asked", async () => {
    const violations: unknown[] = [];
    const off = booted.bus.subscribe("policy.violation", (event) => {
      violations.push(event.payload);
    });

    const asked = (await call(`/api/workspaces/${ws}/channels/${pinned}/messages`, ada.cookie, {
      method: "POST",
      json: { text: "<@scribe> write something" },
    })) as { body: { id: string } };
    await booted.bots.settled();

    const thread = (await call(
      `/api/workspaces/${ws}/messages/${asked.body.id}/thread`,
      ada.cookie,
    )) as { body: { messages: MessageBody[] } };
    const answer = thread.body.messages.find((row) => row.author_type === "bot");
    expect(answer?.blocks[0]?.text).toContain("not on this channel's list of models");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: "models.channels.local-only.allow" });

    // In a room that says nothing about models, the same bot on the same brain answers.
    const elsewhere = (await call(`/api/workspaces/${ws}/channels/${open}/messages`, ada.cookie, {
      method: "POST",
      json: { text: "<@scribe> write something" },
    })) as { body: { id: string } };
    await booted.bots.settled();
    const other = (await call(
      `/api/workspaces/${ws}/messages/${elsewhere.body.id}/thread`,
      ada.cookie,
    )) as { body: { messages: MessageBody[] } };
    expect(other.body.messages.find((row) => row.author_type === "bot")?.blocks[0]?.text).toBe(
      "Here you go.",
    );
    off();
  }, 60_000);
});
