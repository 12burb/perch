import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@perch/events";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.9 end to end: the api's acp engine is the bridge to the project's runner, which spawns a
 * registry-shaped agent (apps/runner/test/fixtures/acp-agent.ts). Two turns with one permission
 * prompt through the REST routes: the edit lands in the project with its diff in the transcript,
 * usage accrues, and the second turn runs in plan mode.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
const fixture = join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "acp-agent.ts");

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
  status: string;
  status_message: string | null;
  engine_session_id: string | null;
  turns: number;
  cost_usd: number;
};
type EventsBody = {
  events: { seq: number; event: EngineEvent | { type: "turn" } }[];
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
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = (await call(`/api/sessions/${id}`, cookie)) as { body: SessionBody };
    if (res.body.status === status) return res.body;
    if (Date.now() > deadline) {
      throw new Error(
        `session stayed ${res.body.status} (${res.body.status_message}), not ${status}`,
      );
    }
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  booted = await bootTestApp({}, { sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-acp-api-"));
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
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  rmSync(projectsDir, { recursive: true, force: true });
});

describe("sessions on the acp engine (task 1.9)", () => {
  test("two turns with one permission prompt, through the api and the runner", async () => {
    const owner = await signUp("Ida", "ida-acp@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "ACP Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;
    const project = await readyProject(owner.cookie, ws, "Agents");

    const opened = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, owner.cookie, {
      method: "POST",
      json: {
        engine: "acp",
        model: { provider: "fake", model_id: "default" },
        prompt: "edit the notes",
      },
    })) as { status: number; body: SessionBody };
    expect(opened.status).toBe(201);
    const id = opened.body.id;
    const waiting = await untilStatus(owner.cookie, id, "needs_you");
    expect(waiting.engine_session_id).toMatch(/^fake-/);
    const answered = await call(`/api/sessions/${id}/permissions/p1`, owner.cookie, {
      method: "POST",
      json: { answer: "allow" },
    });
    expect(answered.status).toBe(200);
    await untilStatus(owner.cookie, id, "idle");
    const replay = (await call(`/api/sessions/${id}/events`, owner.cookie)) as { body: EventsBody };
    const types = replay.body.events.map((e) => e.event.type);
    expect(types).toEqual([
      "turn",
      "text",
      "tool_call",
      "tool_result",
      "tool_call",
      "permission",
      "tool_result",
      "text",
      "usage",
      "done",
    ]);
    const edit = replay.body.events[6]?.event as Extract<EngineEvent, { type: "tool_result" }>;
    expect(edit.diff?.[0]).toMatchObject({ path: "notes.txt", additions: 1, status: "added" });
    const notes = join(projectsDir, ws, project, "notes.txt");
    expect(existsSync(notes)).toBe(true);
    expect(readFileSync(notes, "utf8")).toBe("written by the agent\n");

    const second = await call(`/api/sessions/${id}/turns`, owner.cookie, {
      method: "POST",
      json: { text: "mode?", mode: "plan" },
    });
    expect(second.status).toBe(202);
    const done = await untilStatus(owner.cookie, id, "idle");
    expect(done.turns).toBe(2);
    const tail = (await call(
      `/api/sessions/${id}/events?after_seq=${replay.body.last_seq}`,
      owner.cookie,
    )) as {
      body: EventsBody;
    };
    expect(tail.body.events.map((e) => e.event)).toEqual([
      expect.objectContaining({ type: "turn", mode: "plan" }),
      { type: "text", delta: "plan" },
      expect.objectContaining({ type: "usage" }),
      { type: "done" },
    ]);

    // An agent nobody installed is a 502 at creation, with the runner's reason.
    const ghost = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, owner.cookie, {
      method: "POST",
      json: { engine: "acp", model: { provider: "ghost", model_id: "x" }, prompt: "hi" },
    })) as { status: number; body: SessionBody };
    expect(ghost.status).toBe(201);
    const failed = await untilStatus(owner.cookie, ghost.body.id, "error");
    expect(failed.status_message).toMatch(/unknown ACP agent ghost/);
  }, 60_000);
});
