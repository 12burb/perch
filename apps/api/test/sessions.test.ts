import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { echoScript, FakeEngine } from "@perch/engines";
import type { EngineEvent } from "@perch/events";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.8 (spec §3.3, §7.1, ADR-0074) with the fake engine: a session opens in a project, a turn's
 * events are persisted with a monotonic seq and fanned out on session:<id>, the replay endpoint
 * serves them from a seq, a permission parks the round in needs_you until it is answered, cancel
 * ends a round, an engine error marks the session, strangers see nothing.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";

const fake = new FakeEngine({
  script: (turn, ctx) => {
    if (turn.text.startsWith("ask:")) {
      return [
        { type: "tool_call", id: "c1", name: "fs.write", args: { path: "a.txt" } },
        { type: "permission", id: `p-${ctx.round}`, tool: "fs.write", args: { path: "a.txt" } },
        {
          type: "tool_result",
          id: "c1",
          output: "wrote a.txt",
          diff: [{ path: "a.txt", patch: "+hi\n", additions: 1, deletions: 0, status: "added" }],
        },
        { type: "usage", input: 10, output: 5, costUsd: 0.25 },
        { type: "done" },
      ];
    }
    if (turn.text.startsWith("fail:")) {
      return [
        { type: "text", delta: "oops" },
        { type: "error", message: "the model is down" },
      ];
    }
    return echoScript(turn, ctx);
  },
});

type Envelope = { type: string; topic: string; seq: number; payload: Record<string, unknown> };

class Client {
  readonly received: Envelope[] = [];
  private waiters: Array<{ match: (e: Envelope) => boolean; resolve: (e: Envelope) => void }> = [];
  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const envelope = JSON.parse(String(event.data)) as Envelope;
      this.received.push(envelope);
      const index = this.waiters.findIndex((w) => w.match(envelope));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(envelope);
      }
    });
  }
  static async connect(cookie: string): Promise<Client> {
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/ws`, { headers: { cookie } });
    const client = new Client(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("ws failed to open")));
    });
    return client;
  }
  send(op: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(op));
  }
  next(match: (e: Envelope) => boolean, timeoutMs = 5000): Promise<Envelope> {
    const already = this.received.find(match);
    if (already) {
      this.received.splice(this.received.indexOf(already), 1);
      return Promise.resolve(already);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const seen = this.received.map((e) => `${e.type}@${e.topic}`).join(", ") || "(none)";
        reject(new Error(`timed out waiting for envelope; received so far: ${seen}`));
      }, timeoutMs);
      this.waiters.push({
        match,
        resolve: (e) => {
          clearTimeout(timer);
          this.received.splice(this.received.indexOf(e), 1);
          resolve(e);
        },
      });
    });
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.addEventListener("close", () => resolve());
      this.socket.close();
    });
  }
}

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

type SessionBody = {
  id: string;
  engine: string;
  status: string;
  status_message: string | null;
  model: { provider: string; model_id: string };
  turns: number;
  last_seq: number;
  cost_usd: number;
  engine_session_id: string | null;
};
type EventsBody = {
  events: {
    seq: number;
    ts: string;
    event: EngineEvent | { type: "turn"; text: string; mode: string; userId: string };
  }[];
  last_seq: number;
};

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

async function untilStatus(cookie: string, id: string, status: string): Promise<SessionBody> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = (await call(`/api/sessions/${id}`, cookie)) as { body: SessionBody };
    if (res.body.status === status) return res.body;
    if (Date.now() > deadline) throw new Error(`session stayed ${res.body.status}, not ${status}`);
    await Bun.sleep(20);
  }
}

beforeAll(async () => {
  booted = await bootTestApp({}, { engines: [fake], sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-sessions-api-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  rmSync(projectsDir, { recursive: true, force: true });
});

describe("sessions api (task 1.8)", () => {
  let cookie = "";
  let ws = "";
  let project = "";

  beforeAll(async () => {
    const owner = await signUp("Ada", "ada-sessions@perch.test");
    cookie = owner.cookie;
    const created = (await call("/api/workspaces", cookie, {
      method: "POST",
      json: { name: "Session Nest" },
    })) as { body: { id: string } };
    ws = created.body.id;
    project = await readyProject(cookie, ws, "Agentic");
  }, 60_000);

  test("a turn's events are persisted in order, fanned out on session:<id>, and replayable", async () => {
    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, cookie, {
      method: "POST",
      json: { engine: "fake", title: "First" },
    })) as { status: number; body: SessionBody };
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      engine: "fake",
      status: "idle",
      model: { provider: "engine", model_id: "default" },
      turns: 0,
      last_seq: 0,
    });
    const id = created.body.id;

    const client = await Client.connect(cookie);
    client.send({ op: "subscribe", topics: [`session:${id}`] });
    await client.next((e) => e.type === "subscribed" && e.topic === `session:${id}`);

    const sent = (await call(`/api/sessions/${id}/turns`, cookie, {
      method: "POST",
      json: { text: "hello world" },
    })) as { status: number; body: { seq: number; session: SessionBody } };
    expect(sent.status).toBe(202);
    expect(sent.body.seq).toBe(1);
    expect(sent.body.session.status).toBe("running");
    await client.next((e) => e.type === "session.done" && e.topic === `session:${id}`, 10_000);

    const replay = (await call(`/api/sessions/${id}/events`, cookie)) as { body: EventsBody };
    const types = replay.body.events.map((e) => e.event.type);
    expect(types[0]).toBe("turn");
    expect(replay.body.events[0]?.event).toMatchObject({
      type: "turn",
      text: "hello world",
      mode: "build",
    });
    expect(types.slice(-2)).toEqual(["usage", "done"]);
    expect(types.filter((t) => t === "text").length).toBeGreaterThan(1);
    expect(replay.body.events.map((e) => e.seq)).toEqual(replay.body.events.map((_, i) => i + 1));
    const total = replay.body.events.length;
    expect(replay.body.last_seq).toBe(total);
    const text = replay.body.events
      .map((e) => e.event)
      .filter((e): e is Extract<EngineEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("Echo (build): hello world");

    // From a seq: only what came after.
    const tail = (await call(`/api/sessions/${id}/events?after_seq=${total - 1}`, cookie)) as {
      body: EventsBody;
    };
    expect(tail.body.events.map((e) => e.seq)).toEqual([total]);

    // The WS topic carried the turn, every delta, usage, done, and the status changes.
    const delivered = client.received.map((e) => e.type);
    expect(delivered).toContain("session.turn");
    expect(delivered.filter((t) => t === "session.delta").length).toBe(
      types.filter((t) => t === "text").length,
    );
    expect(delivered).toContain("session.usage");
    expect(delivered).toContain("session.status");
    const turn = client.received.find((e) => e.type === "session.turn");
    expect(turn?.payload).toMatchObject({ sessionId: id, seq: 1, preview: "hello world" });

    const after = await untilStatus(cookie, id, "idle");
    expect(after).toMatchObject({
      turns: 1,
      last_seq: total,
      engine_session_id: `fake-${id.slice(0, 8)}`,
    });
    const list = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, cookie)) as {
      body: { sessions: SessionBody[] };
    };
    expect(list.body.sessions.map((s) => s.id)).toContain(id);
    await client.close();
  }, 30_000);

  test("a permission parks the round in needs_you until it is answered; cost accrues", async () => {
    const answered: unknown[] = [];
    const off = booted.bus.subscribe("session.permission_answered", (e) => {
      answered.push(e.payload);
    });
    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, cookie, {
      method: "POST",
      json: { engine: "fake", prompt: "ask: write a file" },
    })) as { status: number; body: SessionBody };
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("running");
    const id = created.body.id;
    await untilStatus(cookie, id, "needs_you");
    const waiting = (await call(`/api/sessions/${id}/events`, cookie)) as { body: EventsBody };
    expect(waiting.body.events.map((e) => e.event.type)).toEqual([
      "turn",
      "tool_call",
      "permission",
    ]);

    const wrong = await call(`/api/sessions/${id}/permissions/nope`, cookie, {
      method: "POST",
      json: { answer: "allow" },
    });
    expect(wrong.status).toBe(404);
    const ok = (await call(`/api/sessions/${id}/permissions/p-1`, cookie, {
      method: "POST",
      json: { answer: "allow" },
    })) as { status: number; body: SessionBody };
    expect(ok.status).toBe(200);
    expect(["running", "idle"]).toContain(ok.body.status);
    const done = await untilStatus(cookie, id, "idle");
    expect(done.cost_usd).toBe(0.25);
    const all = (await call(`/api/sessions/${id}/events`, cookie)) as { body: EventsBody };
    expect(all.body.events.map((e) => e.event.type)).toEqual([
      "turn",
      "tool_call",
      "permission",
      "tool_result",
      "usage",
      "done",
    ]);
    expect(fake.answers(id)).toEqual([{ id: "p-1", answer: "allow" }]);
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ sessionId: id, permissionId: "p-1", answer: "allow" });
    off();
  }, 30_000);

  test("one round at a time; cancel ends a waiting round; an engine error marks the session", async () => {
    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, cookie, {
      method: "POST",
      json: { engine: "fake", prompt: "ask: again" },
    })) as { body: SessionBody };
    const id = created.body.id;
    await untilStatus(cookie, id, "needs_you");
    const busy = await call(`/api/sessions/${id}/turns`, cookie, {
      method: "POST",
      json: { text: "too soon" },
    });
    expect(busy.status).toBe(409);
    const cancelled = await call(`/api/sessions/${id}/cancel`, cookie, { method: "POST" });
    expect(cancelled).toEqual({ status: 200, body: { cancelled: true } });
    await untilStatus(cookie, id, "idle");
    const events = (await call(`/api/sessions/${id}/events`, cookie)) as { body: EventsBody };
    expect(events.body.events.map((e) => e.event.type)).toEqual([
      "turn",
      "tool_call",
      "permission",
      "done",
    ]);
    expect(fake.answers(id).at(-1)).toEqual({ id: "p-1", answer: "deny" });
    const idle = await call(`/api/sessions/${id}/cancel`, cookie, { method: "POST" });
    expect(idle).toEqual({ status: 200, body: { cancelled: false } });

    const failing = await call(`/api/sessions/${id}/turns`, cookie, {
      method: "POST",
      json: { text: "fail: now", mode: "plan" },
    });
    expect(failing.status).toBe(202);
    const errored = await untilStatus(cookie, id, "error");
    expect(errored.status_message).toBe("the model is down");
    const after = (await call(`/api/sessions/${id}/events?after_seq=4`, cookie)) as {
      body: EventsBody;
    };
    expect(after.body.events.map((e) => e.event.type)).toEqual(["turn", "text", "error"]);
    expect(after.body.events[0]?.event).toMatchObject({ type: "turn", mode: "plan" });
    // The session recovers with the next turn.
    const again = await call(`/api/sessions/${id}/turns`, cookie, {
      method: "POST",
      json: { text: "back" },
    });
    expect(again.status).toBe(202);
    const recovered = await untilStatus(cookie, id, "idle");
    expect(recovered.turns).toBe(3);
  }, 30_000);

  test("strangers see nothing, unknown engines are refused, signed-out callers are forbidden", async () => {
    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, cookie, {
      method: "POST",
      json: { engine: "fake" },
    })) as { body: SessionBody };
    const id = created.body.id;
    const stranger = await signUp("Sol", "sol-sessions@perch.test");
    expect((await call(`/api/sessions/${id}`, stranger.cookie)).status).toBe(404);
    expect(
      (
        await call(`/api/sessions/${id}/turns`, stranger.cookie, {
          method: "POST",
          json: { text: "hi" },
        })
      ).status,
    ).toBe(404);
    expect((await call(`/api/sessions/${id}/events`, stranger.cookie)).status).toBe(404);
    expect(
      (
        await call(`/api/workspaces/${ws}/projects/${project}/sessions`, stranger.cookie, {
          method: "POST",
          json: { engine: "fake" },
        })
      ).status,
    ).toBe(404);
    const client = await Client.connect(stranger.cookie);
    client.send({ op: "subscribe", topics: [`session:${id}`] });
    const refused = await client.next((e) => e.type === "error");
    expect(refused.payload).toMatchObject({ code: "not_found" });
    await client.close();

    const unknown = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, cookie, {
      method: "POST",
      json: { engine: "nope" },
    })) as { status: number; body: { error: { code: string; details: { available: string[] } } } };
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.details.available).toEqual(["acp", "opencode", "fake"]);
    expect((await call(`/api/sessions/${id}`, "")).status).toBe(403);
  }, 30_000);
});
