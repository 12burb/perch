import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEngine } from "@perch/engines";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";
import { decryptPush, subscribeAsBrowser, type UserAgent } from "./fixtures/push.ts";

/**
 * Task 3.17 (spec §5.7 "background by default: sessions keep running when the tab or laptop
 * closes; every state change posts to the task's thread; the phone gets what needs a human"): the
 * acceptance is that a background session finishes overnight and its card is the whole story.
 *
 * Nothing in this file opens a WebSocket, which is the first half of the claim — the session runs
 * because the api is running it, not because somebody is watching. The second half is the card:
 * one message in the channel, rewritten in place, that says at the end what the whole night was.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let pushService: ReturnType<typeof Bun.serve> | null = null;
let cookie = "";
let ws = "";
let project = "";
let channel = "";
let ua: UserAgent;

type Sent = { body: Uint8Array };
const sent: Sent[] = [];

/**
 * One tool it may run without asking, one it must ask about, and a line of its own at the end.
 * The permission is the whole point: "what needs a human" is the only thing that reaches a phone.
 */
const fake = new FakeEngine({
  id: "nightly",
  script: (turn) => [
    { type: "tool_call", id: "r", name: "Read README.md", args: {} },
    { type: "tool_result", id: "r", output: "# the site" },
    { type: "tool_call", id: "w", name: "Write notes.md", args: { path: "notes.md" } },
    { type: "permission", id: "p1", tool: "Write notes.md", args: { path: "notes.md" } },
    {
      type: "tool_result",
      id: "w",
      output: "wrote notes.md",
      diff: [
        {
          path: "notes.md",
          patch: "+a note\n",
          additions: 1,
          deletions: 0,
          status: "added",
        },
      ],
    },
    { type: "usage", input: 40, output: 12, costUsd: 0.25 },
    { type: "text", delta: `done: ${turn.text.slice(0, 20)}` },
    { type: "done" },
  ],
});

beforeAll(async () => {
  pushService = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      sent.push({ body: new Uint8Array(await request.arrayBuffer()) });
      return new Response(null, { status: 201 });
    },
  });
  booted = await bootTestApp({}, { engines: [fake], sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-background-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  ua = await subscribeAsBrowser();
}, 120_000);

afterAll(async () => {
  await running.stop();
  pushService?.stop(true);
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

async function until(check: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("it never happened");
}

type Block = Record<string, unknown>;
type Message = { id: string; blocks: Block[] };

/** Every message in the channel, oldest first — so "one card" can be counted rather than assumed. */
async function messages(): Promise<Message[]> {
  const res = (await call(`/api/workspaces/${ws}/channels/${channel}/messages?limit=100`)) as {
    body: { messages: Message[] };
  };
  return [...res.body.messages].reverse();
}

/** The one background card, whatever else has been said in the channel. */
async function card(): Promise<Block | null> {
  for (const message of await messages()) {
    const found = message.blocks.find((block) => block.type === "background_card");
    if (found) return found;
  }
  return null;
}

async function cardCount(): Promise<number> {
  return (await messages()).filter((message) =>
    message.blocks.some((block) => block.type === "background_card"),
  ).length;
}

let sessionId = "";

describe("background sessions (task 3.17)", () => {
  test("a project, a channel, and a phone to be woken", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-background-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Nightly" } })) as {
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
        json: { name: "nightly", kind: "public" },
      })) as { body: { id: string } }
    ).body.id;

    // A phone, subscribed the way a browser subscribes.
    const endpoint = `${pushService?.url.href}push/robin`;
    expect(
      (
        await call("/api/me/push-subscriptions", {
          method: "POST",
          json: { endpoint, keys: ua.subscription },
        })
      ).status,
    ).toBe(201);
  }, 180_000);

  test("the acceptance: it runs to a finish line with nobody watching, and the card is the story", async () => {
    const started = (await call(`/api/workspaces/${ws}/projects/${project}/sessions/background`, {
      method: "POST",
      json: { prompt: "tidy the notes overnight", engine: "nightly", channel_id: channel },
    })) as { status: number; text: string; body: { id: string; card_message_id: string } };
    expect(started.status, started.text).toBe(201);
    sessionId = started.body.id;
    expect(started.body.card_message_id).toMatch(/^[0-9a-f-]{36}$/);

    // It stops to ask, and that is the one thing a phone hears about.
    await until(async () => (await card())?.state === "needs_you");
    const asking = await card();
    expect(asking?.prompt).toBe("tidy the notes overnight");
    expect(asking?.sessionId).toBe(sessionId);
    expect(String(asking?.url ?? "")).toContain(sessionId);

    await until(() => sent.length > 0);
    const woken = JSON.parse(await decryptPush(sent[0]?.body ?? new Uint8Array(), ua)) as {
      title: string;
      body: string;
      url: string;
    };
    expect(woken.body).toContain("Write notes.md");
    expect(woken.url).toContain(sessionId);

    // Answered, and back to work — the answer comes over HTTP, with no socket anywhere.
    expect(
      (
        await call(`/api/sessions/${sessionId}/permissions/p1`, {
          method: "POST",
          json: { answer: "allow" },
        })
      ).status,
    ).toBe(200);

    // And then it finishes by itself: unattended means it lets go of its runner (ADR-0133).
    await until(async () => (await card())?.state === "done", 120_000);
    const done = await card();
    expect(done?.turns).toBe(1);
    expect(done?.costUsd).toBeCloseTo(0.25, 2);
    expect(done?.filesChanged).toBe(1);
    expect(done?.tools).toBe(2);
    expect(typeof done?.elapsedMs).toBe("number");
    expect(Number(done?.elapsedMs ?? 0)).toBeGreaterThanOrEqual(0);
    expect(String(done?.text ?? "")).toContain("done: tidy the notes");

    // One card, rewritten: a night of work is not a night of notifications.
    expect(await cardCount()).toBe(1);
    // And one push, for the one thing that needed a person.
    expect(sent).toHaveLength(1);

    const session = (await call(`/api/sessions/${sessionId}`)) as { body: { status: string } };
    expect(session.body.status).toBe("ended");
  }, 300_000);

  test("a project that says never is never woken up", async () => {
    sent.length = 0;
    // The project says so in its own file, the way every other background setting is said
    // (task 2.18), and Perch re-reads it on request.
    const checkout = join(projectsDir, ws, project);
    mkdirSync(join(checkout, ".perch"), { recursive: true });
    writeFileSync(
      join(checkout, ".perch", "project.json"),
      JSON.stringify({ background: { notify: "never" } }, null, 2),
    );
    expect(
      (await call(`/api/workspaces/${ws}/projects/${project}/config/reload`, { method: "POST" }))
        .status,
    ).toBe(200);

    const started = (await call(`/api/workspaces/${ws}/projects/${project}/sessions/background`, {
      method: "POST",
      json: { prompt: "quietly", engine: "nightly", channel_id: channel },
    })) as { status: number; text: string; body: { id: string } };
    expect(started.status, started.text).toBe(201);

    // It still stops to ask, and the card still says so — the phone is what stays quiet.
    await until(async () => {
      const row = (await call(`/api/sessions/${started.body.id}`)) as {
        body: { status: string };
      };
      return row.body.status === "needs_you";
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent).toHaveLength(0);
    expect(await cardCount()).toBe(2);
  }, 180_000);

  test("a background session needs a channel to report in", async () => {
    const nowhere = await call(`/api/workspaces/${ws}/projects/${project}/sessions/background`, {
      method: "POST",
      json: { prompt: "into the void", engine: "nightly" },
    });
    expect(nowhere.status).toBe(422);
  }, 60_000);
});
