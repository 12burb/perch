import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.1 (spec §5.3 "spec bots bots/<handle>/bot.yaml + SYSTEM.md + skills/ in the Agent Skills
 * format, hot-reload on push").
 *
 * The acceptance is the second test: a bot defined in a repository answers in a channel, and
 * editing its SYSTEM.md changes the next answer without anything restarting. The stand-in model
 * answers with the first line of the system prompt it was handed, so what the bot says *is* what
 * the repository says it is.
 */

let booted: Booted;
let running: RunningServer;
let model: ReturnType<typeof Bun.serve> | null = null;
let base = "";
let projectsDir = "";
let ws = "";
let cookie = "";
let channel = "";
let project = "";

const PERSONA = "You are Scribe. You take notes.";

const BOT_YAML = `handle: scribe
name: Scribe
persona: ./SYSTEM.md
brain:
  model: Nest brain
triggers:
  - mention
budget:
  daily_usd: 5
`;

beforeAll(async () => {
  // An OpenAI-compatible endpoint that says back the first line of what it was told to be: the
  // shortest honest way to prove the persona reached the model.
  model = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "stub-1" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("no", { status: 404 });
      const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
      // The whole system prompt, flattened: Perch writes a preamble before the persona, and what
      // this test is about is that the persona got there at all.
      const system = body.messages.find((one) => one.role === "system");
      const said = String(system?.content ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 400);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "stub-1",
            choices: [{ index: 0, delta: { content: `Reading: ${said}` }, finish_reason: null }],
          });
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "stub-1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
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
  booted = await bootTestApp({});
  projectsDir = mkdtempSync(join(tmpdir(), "perch-spec-bots-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

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
type Sync = {
  added: string[];
  updated: string[];
  removed: string[];
  failed: { handle: string; error: string }[];
};
type BotRow = {
  id: string;
  handle: string;
  name: string;
  level: string;
  status: string;
  spec: { persona?: string; skills?: { name: string }[] };
};
type MessageRow = { id: string; author_type: string; blocks: { type: string; text?: string }[] };

const write = (path: string, content: string) =>
  call(`/api/workspaces/${ws}/projects/${project}/fs/write`, {
    method: "PUT",
    json: { path, content },
  });

const reload = async (): Promise<Sync> =>
  (
    (await call(`/api/workspaces/${ws}/projects/${project}/bots/reload`, {
      method: "POST",
    })) as { body: Sync }
  ).body;

const botsNow = async (): Promise<BotRow[]> =>
  ((await call(`/api/workspaces/${ws}/bots`)) as { body: { bots: BotRow[] } }).body.bots;

/** Says something in the channel and waits for a bot answer whose text carries `looks`. */
async function askBot(text: string, looks: string): Promise<string> {
  const said = (await call(`/api/workspaces/${ws}/channels/${channel}/messages`, {
    method: "POST",
    json: { text },
  })) as { status: number; body: Id };
  expect(said.status).toBe(201);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = (await call(`/api/workspaces/${ws}/messages/${said.body.id}/thread`)) as {
      body: { messages: MessageRow[] };
    };
    const answer = res.body.messages.find(
      (one) => one.author_type === "bot" && (one.blocks[0]?.text ?? "").includes(looks),
    );
    if (answer) return answer.blocks[0]?.text ?? "";
    if (Date.now() > deadline) {
      throw new Error(`no answer: ${JSON.stringify(res.body.messages.map((m) => m.blocks))}`);
    }
    await Bun.sleep(50);
  }
}

describe("bots that live in a repository (task 3.1)", () => {
  test("a bots/ directory becomes bots, with its persona and its skills", async () => {
    const signed = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Ada",
        email: `ada-specbots-${Date.now()}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signed.status).toBe(200);
    cookie = cookiesFrom(signed);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Nest" } })) as {
        body: Id;
      }
    ).body.id;

    const made = (await call(`/api/workspaces/${ws}/channels`, {
      method: "POST",
      json: { type: "public", name: "general" },
    })) as { body: Id };
    channel = made.body.id;

    // The brain the file names. `model:` in bot.yaml is the profile's name (ADR-0116).
    const credential = (await call(`/api/workspaces/${ws}/credentials`, {
      method: "POST",
      json: {
        provider: "custom",
        kind: "endpoint",
        scope: "workspace",
        label: "Stand-in",
        base_url: `${model?.url.origin}/v1`,
      },
    })) as { body: Id };
    const profile = await call(`/api/workspaces/${ws}/model-profiles`, {
      method: "POST",
      json: {
        name: "Nest brain",
        provider: "custom",
        model_id: "stub-1",
        credential_id: credential.body.id,
        default_for: "chat",
      },
    });
    expect(profile.status).toBe(201);

    const created = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "Nest repo" },
    })) as { body: Id };
    project = created.body.id;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const row = (await call(`/api/workspaces/${ws}/projects/${project}`)) as {
        body: { status: string };
      };
      if (row.body.status === "ready") break;
      if (Date.now() > deadline) throw new Error(`project stayed ${row.body.status}`);
      await Bun.sleep(50);
    }

    expect((await write("bots/scribe/bot.yaml", BOT_YAML)).status).toBe(200);
    expect((await write("bots/scribe/SYSTEM.md", `${PERSONA}\n`)).status).toBe(200);
    expect(
      (
        await write(
          "bots/scribe/skills/headlines/SKILL.md",
          "---\nname: Headlines\ndescription: When asked for the news.\n---\nRead the wire first.\n",
        )
      ).status,
    ).toBe(200);
    // A file that is not a bot is not read as one.
    expect((await write("src/index.ts", "export const app = 1;\n")).status).toBe(200);

    const synced = await reload();
    expect(synced).toEqual({ added: ["scribe"], updated: [], removed: [], failed: [] });

    const bots = await botsNow();
    const scribe = bots.find((one) => one.handle === "scribe");
    expect(scribe).toBeDefined();
    expect(scribe?.level).toBe("spec");
    expect(scribe?.name).toBe("Scribe");
    expect(scribe?.spec.persona).toContain("take notes");
    expect(scribe?.spec.skills?.map((one) => one.name)).toEqual(["Headlines"]);

    // Syncing again with nothing changed changes nothing.
    expect(await reload()).toEqual({ added: [], updated: [], removed: [], failed: [] });
  }, 120_000);

  test("it answers in a channel, and editing SYSTEM.md changes the next answer", async () => {
    const bots = await botsNow();
    const scribe = bots.find((one) => one.handle === "scribe");
    const installed = await call(`/api/workspaces/${ws}/bots/${scribe?.id}/install`, {
      method: "POST",
      json: { channel_id: channel },
    });
    expect(installed.status).toBe(200);

    expect(await askBot("@scribe what is the plan?", "Reading:")).toContain("You take notes.");

    // The repository changes; nothing restarts.
    expect(
      (await write("bots/scribe/SYSTEM.md", "You are Scribe. You count birds.\n")).status,
    ).toBe(200);
    expect(await reload()).toMatchObject({ added: [], updated: ["scribe"], removed: [] });

    expect(await askBot("@scribe and now?", "Reading:")).toContain("You count birds.");
  }, 120_000);

  test("a bot.yaml that stops making sense pauses that bot and says why", async () => {
    expect((await write("bots/scribe/bot.yaml", "tools: [rm_rf]\n")).status).toBe(200);
    const synced = await reload();
    expect(synced.added).toEqual([]);
    expect(synced.failed).toHaveLength(1);
    expect(synced.failed[0]?.handle).toBe("scribe");
    expect(synced.failed[0]?.error).toContain("bots/scribe/bot.yaml");

    const scribe = (await botsNow()).find((one) => one.handle === "scribe");
    expect(scribe?.status).toBe("paused");

    // And it comes back when the file does.
    expect((await write("bots/scribe/bot.yaml", BOT_YAML)).status).toBe(200);
    expect(await reload()).toMatchObject({ updated: ["scribe"] });
    expect((await botsNow()).find((one) => one.handle === "scribe")?.status).toBe("active");
  }, 120_000);

  test("a code bot answers a mention, and one that loops is stopped by its ceiling", async () => {
    // A second bot in the same repository, this one with a bot.js beside its bot.yaml.
    expect(
      (
        await write(
          "bots/tally/bot.yaml",
          "handle: tally\nname: Tally\ntools: [chat_post]\ntriggers:\n  - mention\n",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await write(
          "bots/tally/bot.js",
          `export default bot({
             async onMessage(event, perch) {
               perch.log("counting", event.text.length);
               return "I counted " + event.text.length + " characters.";
             },
           });`,
        )
      ).status,
    ).toBe(200);
    const synced = await reload();
    expect(synced.added).toEqual(["tally"]);

    const tally = (await botsNow()).find((one) => one.handle === "tally");
    expect(tally?.level).toBe("code");
    const installed = await call(`/api/workspaces/${ws}/bots/${tally?.id}/install`, {
      method: "POST",
      json: { channel_id: channel },
    });
    expect(installed.status).toBe(200);

    // It answers without a model: what it says is what its own JavaScript returned.
    const said = "@tally count this";
    const answer = await askBot(said, "I counted");
    expect(answer).toBe(`I counted ${said.length} characters.`);

    // And one that will not stop is stopped, with the reason where it was asked.
    expect(
      (
        await write(
          "bots/tally/bot.js",
          "export default bot({ onMessage: () => { while (true) {} } });",
        )
      ).status,
    ).toBe(200);
    expect(await reload()).toMatchObject({ updated: ["tally"] });
    const stopped = await askBot("@tally count this too", "did not run");
    expect(stopped).toContain("interrupt");
  }, 120_000);

  test("a bot whose directory is gone is gone", async () => {
    // Perch has no route that deletes a directory, so this is a person on the machine doing what
    // `git rm -r bots/scribe && git pull` would do to the checkout.
    rmSync(join(projectsDir, ws, project, "bots", "scribe"), { recursive: true, force: true });
    expect(await reload()).toMatchObject({ added: [], updated: [], removed: ["scribe"] });
    expect((await botsNow()).find((one) => one.handle === "scribe")).toBeUndefined();
  }, 120_000);
});
