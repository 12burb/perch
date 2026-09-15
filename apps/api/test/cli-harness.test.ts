import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@perch/events";
import { CLI_HARNESS, type CliHarnessSpec, createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.11 through the api: with the cli_harness flag on (PERCH_FLAGS), a session on the
 * cli-harness engine runs the stand-in Codex CLI on the laptop runner and its stream lands in the
 * transcript; the flags module reads PERCH_FLAGS and the `flags` instance setting.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
const fixtures = join(import.meta.dir, "..", "..", "runner", "test", "fixtures");

function viaBun(id: string, fixture: string): CliHarnessSpec {
  const spec = CLI_HARNESS[id];
  if (!spec) throw new Error(`no spec ${id}`);
  return {
    ...spec,
    command: process.execPath,
    args: (t) => [join(fixtures, fixture), ...spec.args(t)],
  };
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

type SessionBody = { id: string; status: string; status_message: string | null; turns: number };
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
  booted = await bootTestApp({ PERCH_FLAGS: "cli_harness" }, { sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-cli-harness-api-"));
  booted.runners.attach(
    createInProcessRunner({
      projectsDir,
      portsIntervalMs: 0,
      sessions: {
        cliHarness: { allowed: true, tools: { codex: viaBun("codex", "fake-codex.ts") } },
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

describe("the cli-harness engine through the api (task 1.11)", () => {
  test("flags: PERCH_FLAGS turns the lane on; the instance setting wins over it", async () => {
    expect(await booted.flags.isOn("cli_harness")).toBe(true);
    expect(await booted.flags.list()).toEqual({ cli_harness: true });
  });

  test("with the flag on, a turn runs the CLI on the laptop runner and lands in the transcript", async () => {
    const owner = await signUp("Kai", "kai-cli@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "CLI Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;
    const project = await readyProject(owner.cookie, ws, "Harness");
    const opened = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, owner.cookie, {
      method: "POST",
      json: {
        engine: "cli-harness",
        model: { provider: "codex", model_id: "default" },
        prompt: "list the files",
      },
    })) as { status: number; body: SessionBody };
    expect(opened.status).toBe(201);
    const id = opened.body.id;
    const done = await untilStatus(owner.cookie, id, "idle");
    expect(done.turns).toBe(1);
    const replay = (await call(`/api/sessions/${id}/events`, owner.cookie)) as { body: EventsBody };
    expect(replay.body.events.map((e) => e.event.type)).toEqual([
      "turn",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "text",
      "usage",
      "done",
    ]);
    expect(replay.body.events[5]?.event).toEqual({
      type: "text",
      delta: "Codex says: fresh list the files",
    });
    // An unknown CLI is refused by the runner with the reason.
    const ghost = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, owner.cookie, {
      method: "POST",
      json: { engine: "cli-harness", agent: "ghost", prompt: "hi" },
    })) as { body: SessionBody };
    const failed = await untilStatus(owner.cookie, ghost.body.id, "error");
    expect(failed.status_message).toMatch(/unknown CLI ghost/);
  }, 60_000);
});
