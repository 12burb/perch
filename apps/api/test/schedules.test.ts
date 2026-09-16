import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { worthRunning } from "../src/services/bots.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.5 (spec §5.3 `schedule (cron)`): a bot that wakes up on a timer. The acceptance is the
 * second test — a morning digest on weekdays, in the zone the bot was written in, that says when it
 * last ran. The rest is the part nobody thinks about until it bites: what happens to the nine
 * o'clock firing when Perch was not up at nine.
 */

let booted: Booted;
let running: RunningServer;
let model: ReturnType<typeof Bun.serve> | null = null;
let base = "";
let ws = "";
let cookie = "";
let channelId = "";
let botId = "";

beforeAll(async () => {
  model = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "stub-1" }] });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "stub-1",
            choices: [
              { index: 0, delta: { content: "Today: three things." }, finish_reason: null },
            ],
          });
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "stub-1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
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
type Schedule = {
  index: number;
  cron: string;
  timezone: string;
  channel: string | null;
  prompt: string | null;
  catch_up: boolean;
  catch_up_grace_minutes: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
};
type MessageRow = { author_type: string; blocks: { text?: string }[] };

const schedules = async (): Promise<Schedule[]> =>
  (
    (await call(`/api/workspaces/${ws}/bots/${botId}/schedules`)) as {
      body: { schedules: Schedule[] };
    }
  ).body.schedules;

describe("a bot that wakes up on a timer (task 3.5)", () => {
  test("a schedule is read in the bot's own zone", async () => {
    const signed = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Ada",
        email: `ada-cron-${Date.now()}@perch.test`,
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
    channelId = (
      (await call(`/api/workspaces/${ws}/channels`, {
        method: "POST",
        json: { type: "public", name: "newsroom" },
      })) as { body: Id }
    ).body.id;

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
    await call(`/api/workspaces/${ws}/model-profiles`, {
      method: "POST",
      json: {
        name: "Nest brain",
        provider: "custom",
        model_id: "stub-1",
        credential_id: credential.body.id,
        default_for: "chat",
      },
    });

    const made = (await call(`/api/workspaces/${ws}/bots`, {
      method: "POST",
      json: {
        handle: "digest",
        name: "Digest",
        visibility: "workspace",
        budget: { dailyUsd: 5 },
        spec: {
          persona: "You write the morning digest.",
          brain: { profile: "Nest brain" },
          timezone: "Europe/London",
          triggers: [
            {
              on: "schedule",
              cron: "0 9 * * 1-5",
              prompt: "Post today's headlines",
              channel: "newsroom",
            },
          ],
          tools: [],
        },
      },
    })) as { status: number; body: Id };
    expect(made.status).toBe(201);
    botId = made.body.id;
    await call(`/api/workspaces/${ws}/bots/${botId}/install`, {
      method: "POST",
      json: { channel_id: channelId },
    });

    const rows = await schedules();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cron).toBe("0 9 * * 1-5");
    expect(rows[0]?.timezone).toBe("Europe/London");
    expect(rows[0]?.channel).toBe("newsroom");
    expect(rows[0]?.catch_up).toBe(true);
    expect(rows[0]?.last_run_at).toBeNull();

    // The next firing is nine in London, which is eight or nine UTC depending on the season —
    // never the other hours, which is what a zone is for.
    const next = new Date(rows[0]?.next_run_at ?? "");
    expect(Number.isNaN(next.getTime())).toBe(false);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    const inLondon = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    }).formatToParts(next);
    expect(inLondon.find((part) => part.type === "hour")?.value).toBe("09");
    expect(["Sat", "Sun"]).not.toContain(inLondon.find((p) => p.type === "weekday")?.value);
  }, 60_000);

  test("it posts the digest, and the schedule says when it last ran", async () => {
    // What the queue does at nine, done now: the same handler, with the same payload.
    await booted.bots.runScheduled({ botId, index: 0 });
    await booted.bots.settled();

    const messages = (await call(`/api/workspaces/${ws}/channels/${channelId}/messages`)) as {
      body: { messages: MessageRow[] };
    };
    const said = messages.body.messages.filter(
      (one) => one.author_type === "bot" && (one.blocks[0]?.text ?? "").includes("Today"),
    );
    expect(said).toHaveLength(1);

    const rows = await schedules();
    expect(rows[0]?.last_run_at).not.toBeNull();
    expect(rows[0]?.last_status).toBe("done");
    expect(Date.now() - new Date(rows[0]?.last_run_at ?? 0).getTime()).toBeLessThan(60_000);
  }, 60_000);

  test("a firing Perch was down for runs late, unless the bot said not to", async () => {
    const before = (
      (await call(`/api/workspaces/${ws}/channels/${channelId}/messages`)) as {
        body: { messages: MessageRow[] };
      }
    ).body.messages.length;

    // Nine o'clock, noticed at half past: still worth posting.
    await booted.bots.runScheduled(
      { botId, index: 0 },
      { due: new Date(Date.now() - 30 * 60_000) },
    );
    await booted.bots.settled();
    const after = (
      (await call(`/api/workspaces/${ws}/channels/${channelId}/messages`)) as {
        body: { messages: MessageRow[] };
      }
    ).body.messages.length;
    expect(after).toBe(before + 1);

    // Nine o'clock, noticed at six: not a morning digest any more.
    await booted.bots.runScheduled(
      { botId, index: 0 },
      { due: new Date(Date.now() - 9 * 60 * 60_000) },
    );
    await booted.bots.settled();
    expect(
      (
        (await call(`/api/workspaces/${ws}/channels/${channelId}/messages`)) as {
          body: { messages: MessageRow[] };
        }
      ).body.messages.length,
    ).toBe(after);
  }, 60_000);

  test("a zone this machine has never heard of is refused where it was written", async () => {
    const bad = await call(`/api/workspaces/${ws}/bots`, {
      method: "POST",
      json: {
        handle: "lost",
        name: "Lost",
        spec: {
          timezone: "Mars/Olympus_Mons",
          triggers: [{ on: "schedule", cron: "0 9 * * *", prompt: "hello" }],
        },
      },
    });
    expect(bad.status).toBe(422);
    expect(bad.text).toContain("time zone");
  }, 60_000);
});

describe("whether a missed firing is still worth running", () => {
  const nine = new Date("2026-09-16T09:00:00Z");
  const later = (minutes: number) => new Date(nine.getTime() + minutes * 60_000);

  test("on time is always worth running", () => {
    expect(worthRunning({}, nine, nine)).toBe(true);
    expect(worthRunning({ catchUp: false }, nine, later(0.5))).toBe(true);
  });

  test("late is worth running for an hour, by default", () => {
    expect(worthRunning({}, nine, later(30))).toBe(true);
    expect(worthRunning({}, nine, later(59))).toBe(true);
    expect(worthRunning({}, nine, later(90))).toBe(false);
  });

  test("a bot may say how late is too late, or that late is never worth it", () => {
    expect(worthRunning({ catchUpGraceMinutes: 240 }, nine, later(200))).toBe(true);
    expect(worthRunning({ catchUpGraceMinutes: 10 }, nine, later(30))).toBe(false);
    expect(worthRunning({ catchUp: false }, nine, later(5))).toBe(false);
  });
});
