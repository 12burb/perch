import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.18 (spec §5.1 "quick actions from .perch/project.json run commands plus custom actions,
 * background policy per project: what runs unattended, what waits, auto-settle"; §4's composer
 * reasoning level).
 *
 * Four things, all of them the project's own `.perch/project.json` deciding how Perch behaves: the
 * actions a project offers, the level a turn thinks at, the tools that may run with nobody
 * watching, and whether a finished round lets its session go.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let ws = "";
let cookie = "";
const fixture = join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "acp-agent.ts");

const CONFIG = {
  run: { test: "bun test", build: "bun run build" },
  actions: [
    { id: "review", name: "Review my changes", prompt: "mode?", mode: "plan", reasoning: "high" },
    { id: "test", name: "Run the tests", run: "test" },
    { id: "smoke", name: "Smoke", run: "echo smoke" },
  ],
};

beforeAll(async () => {
  booted = await bootTestApp({}, { sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-actions-"));
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

type Action = {
  id: string;
  name: string;
  kind: "prompt" | "run";
  prompt: string | null;
  command: string | null;
  mode: "plan" | "build" | null;
  reasoning: string | null;
};
type ProjectBody = { id: string; status: string; actions: Action[] };
type SessionBody = { id: string; status: string; reasoning: string };
type EventsBody = {
  events: { seq: number; event: { type: string; delta?: string; output?: string } }[];
};

/** A project with `.perch/project.json` written into it, set up the way a clone would arrive. */
async function projectWith(name: string, config: unknown): Promise<string> {
  const created = (await call(`/api/workspaces/${ws}/projects`, {
    method: "POST",
    json: { name },
  })) as { body: { id: string } };
  const id = created.body.id;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = (await call(`/api/workspaces/${ws}/projects/${id}`)) as { body: ProjectBody };
    if (res.body.status === "ready") break;
    if (Date.now() > deadline) throw new Error(`project stayed ${res.body.status}`);
    await Bun.sleep(50);
  }
  const written = await call(`/api/workspaces/${ws}/projects/${id}/fs/write`, {
    method: "PUT",
    json: { path: ".perch/project.json", content: JSON.stringify(config, null, 2) },
  });
  expect(written.status).toBe(200);
  // Re-reading the config is what a runner does on setup; the api has a route for it.
  const reloaded = await call(`/api/workspaces/${ws}/projects/${id}/config/reload`, {
    method: "POST",
  });
  expect(reloaded.status).toBe(200);
  return id;
}

async function settle(id: string): Promise<SessionBody> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = (await call(`/api/sessions/${id}`)) as { body: SessionBody };
    if (res.body.status !== "running") return res.body;
    if (Date.now() > deadline) throw new Error(`session stayed ${res.body.status}`);
    await Bun.sleep(50);
  }
}

describe("quick actions and the background policy (task 2.18)", () => {
  test("a project's run commands and its own actions arrive as one list", async () => {
    const signed = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Ada",
        email: `ada-actions-${Date.now()}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signed.status).toBe(200);
    cookie = cookiesFrom(signed);
    const made = (await call("/api/workspaces", {
      method: "POST",
      json: { name: "Actions Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;

    const project = await projectWith("Acted", CONFIG);
    const read = (await call(`/api/workspaces/${ws}/projects/${project}`)) as {
      body: ProjectBody;
    };
    const actions = read.body.actions;
    // `build` is a run command nobody customised; `test` is one the project renamed and kept.
    expect(actions.map((one) => one.id).sort()).toEqual(["build", "review", "smoke", "test"]);
    const byId = new Map(actions.map((one) => [one.id, one]));
    expect(byId.get("build")).toMatchObject({
      kind: "run",
      command: "bun run build",
      name: "build",
    });
    expect(byId.get("test")).toMatchObject({
      kind: "run",
      command: "bun test",
      name: "Run the tests",
    });
    // A run action naming something that is not a command is the command itself.
    expect(byId.get("smoke")).toMatchObject({ kind: "run", command: "echo smoke" });
    expect(byId.get("review")).toMatchObject({
      kind: "prompt",
      prompt: "mode?",
      mode: "plan",
      reasoning: "high",
    });
  }, 60_000);

  test("an action's prompt runs as a turn, in the action's own mode", async () => {
    const projects = (await call(`/api/workspaces/${ws}/projects`)) as {
      body: { projects: ProjectBody[] };
    };
    const project = projects.body.projects[0]?.id ?? "";
    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
      method: "POST",
      json: { engine: "acp", title: "Acts" },
    })) as { status: number; body: SessionBody };
    expect(created.status).toBe(201);
    // A session starts on the agent's own choice of effort.
    expect(created.body.reasoning).toBe("auto");

    const action = { text: "mode?", mode: "plan" as const, reasoning: "high" as const };
    const sent = await call(`/api/sessions/${created.body.id}/turns`, {
      method: "POST",
      json: action,
    });
    expect(sent.status).toBe(202);
    await settle(created.body.id);
    const replay = (await call(`/api/sessions/${created.body.id}/events`)) as { body: EventsBody };
    const said = replay.body.events
      .filter((one) => one.event.type === "text")
      .map((one) => one.event.delta ?? "")
      .join("");
    // The fake agent answers a "mode?" turn with the mode it was put in.
    expect(said).toContain("plan");
    // One turn's level does not become the session's.
    const after = (await call(`/api/sessions/${created.body.id}`)) as { body: SessionBody };
    expect(after.body.reasoning).toBe("auto");
  }, 60_000);

  test("a session's reasoning level is set and kept", async () => {
    const projects = (await call(`/api/workspaces/${ws}/projects`)) as {
      body: { projects: ProjectBody[] };
    };
    const project = projects.body.projects[0]?.id ?? "";
    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
      method: "POST",
      json: { engine: "acp", reasoning: "low" },
    })) as { body: SessionBody };
    expect(created.body.reasoning).toBe("low");
    const patched = (await call(`/api/sessions/${created.body.id}`, {
      method: "PATCH",
      json: { reasoning: "high" },
    })) as { status: number; body: SessionBody };
    expect(patched.status).toBe(200);
    expect(patched.body.reasoning).toBe("high");
    // A level that is not one of the four is refused rather than stored.
    const bad = await call(`/api/sessions/${created.body.id}`, {
      method: "PATCH",
      json: { reasoning: "ludicrous" },
    });
    expect(bad.status).toBe(422);
  }, 60_000);

  test("an unattended tool runs without asking, and auto-settle ends the session", async () => {
    const project = await projectWith("Unattended", {
      background: { unattended: ["Edit *"], autoSettle: true },
    });
    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
      method: "POST",
      json: { engine: "acp", title: "Runs alone" },
    })) as { body: SessionBody };
    const sent = await call(`/api/sessions/${created.body.id}/turns`, {
      method: "POST",
      json: { text: "edit the notes" },
    });
    expect(sent.status).toBe(202);

    // The round would normally park in needs_you waiting for Allow; here nobody is asked.
    const deadline = Date.now() + 30_000;
    let last = "";
    for (;;) {
      const res = (await call(`/api/sessions/${created.body.id}`)) as { body: SessionBody };
      last = res.body.status;
      if (last === "ended" || last === "error") break;
      expect(last).not.toBe("needs_you");
      if (Date.now() > deadline) throw new Error(`session stayed ${last}`);
      await Bun.sleep(50);
    }
    // Auto-settle: the round finished with nothing waiting, so the session let itself go.
    expect(last).toBe("ended");

    const replay = (await call(`/api/sessions/${created.body.id}/events`)) as {
      text: string;
      body: EventsBody;
    };
    // The transcript says the project allowed it, rather than pretending somebody pressed a button.
    expect(replay.text).toContain("allowed without asking");
    const said = replay.body.events
      .filter((one) => one.event.type === "text")
      .map((one) => one.event.delta ?? "")
      .join("");
    expect(said).toContain("applied the edit");
  }, 60_000);

  test("a tool that is not unattended still waits for a person", async () => {
    const project = await projectWith("Asks", {
      background: { unattended: ["Read *"], autoSettle: false },
    });
    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
      method: "POST",
      json: { engine: "acp", title: "Asks first" },
    })) as { body: SessionBody };
    await call(`/api/sessions/${created.body.id}/turns`, {
      method: "POST",
      json: { text: "edit the notes" },
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = (await call(`/api/sessions/${created.body.id}`)) as { body: SessionBody };
      if (res.body.status === "needs_you") break;
      if (res.body.status === "ended" || res.body.status === "error") {
        throw new Error(`session went to ${res.body.status} without asking`);
      }
      if (Date.now() > deadline) throw new Error(`session stayed ${res.body.status}`);
      await Bun.sleep(50);
    }
  }, 60_000);
});
