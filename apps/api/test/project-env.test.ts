import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.13 (spec §5.7 "encrypted per-project env; injected into runner, previews, sessions; never
 * into a model context"). The acceptance is the last test: a session sees DATABASE_URL, and the
 * value never appears in the transcript — the agent is asked to print it, and what is written down
 * says which name it was instead.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let ws = "";
let project = "";
let cookie = "";
const fixture = join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "acp-agent.ts");

const SECRET = "postgres://perch:h8Zq2LmZzQw81Pa@db:5432/perch";

beforeAll(async () => {
  booted = await bootTestApp({}, { sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-env-"));
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
    .map((c) => c.split(";")[0] ?? "")
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

type EnvBody = { vars: { key: string; source: string; updated_at: string }[] };
type SessionBody = { id: string; status: string };
type EventsBody = { events: { seq: number; event: { type: string; delta?: string } }[] };

describe("a project's environment (task 2.13)", () => {
  test("a project, and two variables in it", async () => {
    const res = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Ada",
        email: `ada-env-${Date.now()}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(res.status).toBe(200);
    cookie = cookiesFrom(res);
    const made = (await call("/api/workspaces", {
      method: "POST",
      json: { name: "Env Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const created = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "Agentic" },
    })) as { body: { id: string } };
    project = created.body.id;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res2 = (await call(`/api/workspaces/${ws}/projects/${project}`)) as {
        body: { status: string };
      };
      if (res2.body.status === "ready") break;
      if (Date.now() > deadline) throw new Error(`project stayed ${res2.body.status}`);
      await Bun.sleep(50);
    }

    const empty = (await call(`/api/workspaces/${ws}/projects/${project}/env`)) as {
      status: number;
      body: EnvBody;
    };
    expect(empty.status).toBe(200);
    expect(empty.body.vars).toEqual([]);

    const written = (await call(`/api/workspaces/${ws}/projects/${project}/env`, {
      method: "PUT",
      json: {
        vars: [
          { key: "DATABASE_URL", value: SECRET },
          { key: "FEATURE_FLAG", value: "on" },
        ],
      },
    })) as { status: number; text: string; body: EnvBody };
    expect(written.status).toBe(200);
    expect(written.body.vars.map((one) => one.key)).toEqual(["DATABASE_URL", "FEATURE_FLAG"]);
    expect(written.body.vars[0]?.source).toBe("manual");
    // A value goes in and never comes back: not here, not anywhere.
    expect(written.text).not.toContain(SECRET);
    const read = (await call(`/api/workspaces/${ws}/projects/${project}/env`)) as { text: string };
    expect(read.text).not.toContain(SECRET);

    // A name a shell could not carry is refused.
    const bad = await call(`/api/workspaces/${ws}/projects/${project}/env`, {
      method: "PUT",
      json: { vars: [{ key: "not a name", value: "x" }] },
    });
    expect(bad.status).toBe(422);

    // And taking one out leaves the other.
    const fewer = (await call(`/api/workspaces/${ws}/projects/${project}/env`, {
      method: "PUT",
      json: { vars: [], remove: ["FEATURE_FLAG"] },
    })) as { body: EnvBody };
    expect(fewer.body.vars.map((one) => one.key)).toEqual(["DATABASE_URL"]);
  }, 60_000);

  test("a session sees DATABASE_URL, and it never appears in the transcript", async () => {
    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
      method: "POST",
      json: { engine: "acp", title: "Reads the environment" },
    })) as { status: number; body: SessionBody };
    expect(created.status).toBe(201);
    const id = created.body.id;

    const sent = await call(`/api/sessions/${id}/turns`, {
      method: "POST",
      json: { text: "secret?" },
    });
    expect(sent.status).toBe(202);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = (await call(`/api/sessions/${id}`)) as { body: SessionBody };
      if (res.body.status === "idle" || res.body.status === "error") break;
      if (Date.now() > deadline) throw new Error(`session stayed ${res.body.status}`);
      await Bun.sleep(50);
    }

    const replay = (await call(`/api/sessions/${id}/events`)) as { text: string; body: EventsBody };
    const said = replay.body.events
      .filter((one) => one.event.type === "text")
      .map((one) => one.event.delta ?? "")
      .join("");
    // The agent was given the variable — it answered with its name rather than "none" …
    expect(said).toContain("DATABASE_URL=");
    expect(said).not.toContain("none");
    // … and what was written down says which name it was, not what it said.
    expect(said).toContain("[redacted: DATABASE_URL]");
    expect(replay.text).not.toContain(SECRET);
    expect(replay.text).not.toContain("h8Zq2LmZ");
  }, 60_000);

  test("a brain's key reaches the engine, and never the transcript (AGENTS.md §1.6)", async () => {
    const KEY = "sk-brain-Qm7xVt19Ka3pLw0ZrE4f2a";
    const credential = (await call(`/api/workspaces/${ws}/credentials`, {
      method: "POST",
      json: {
        provider: "openai",
        kind: "api_key",
        scope: "workspace",
        label: "Brain",
        secret: KEY,
      },
    })) as { status: number; text: string; body: { id: string } };
    expect(credential.status, credential.text).toBe(201);
    const profile = (await call(`/api/workspaces/${ws}/model-profiles`, {
      method: "POST",
      json: {
        name: "Keyed brain",
        provider: "openai",
        model_id: "gpt-test",
        credential_id: credential.body.id,
      },
    })) as { status: number; text: string; body: { id: string } };
    expect(profile.status, profile.text).toBe(201);

    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
      method: "POST",
      json: { engine: "acp", title: "Reads its key", model_profile_id: profile.body.id },
    })) as { status: number; text: string; body: SessionBody };
    expect(created.status, created.text).toBe(201);
    const id = created.body.id;
    const sent = await call(`/api/sessions/${id}/turns`, {
      method: "POST",
      json: { text: "key?" },
    });
    expect(sent.status).toBe(202);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = (await call(`/api/sessions/${id}`)) as { body: SessionBody };
      if (res.body.status === "idle" || res.body.status === "error") break;
      if (Date.now() > deadline) throw new Error(`session stayed ${res.body.status}`);
      await Bun.sleep(50);
    }

    const replay = (await call(`/api/sessions/${id}/events`)) as { text: string; body: EventsBody };
    const said = replay.body.events
      .filter((one) => one.event.type === "text")
      .map((one) => one.event.delta ?? "")
      .join("");
    // The engine had the key (spec §3.4: engines get native provider credentials) …
    expect(said).toContain("OPENAI_API_KEY=");
    expect(said).not.toContain("none");
    // … and the transcript — a model context, a client's view — has its name and not the key.
    expect(said).toContain("[redacted: OPENAI_API_KEY]");
    expect(replay.text).not.toContain(KEY);
  }, 60_000);
});
