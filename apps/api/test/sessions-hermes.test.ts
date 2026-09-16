import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@perch/events";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.8 (spec §3.3 `hermes = Hermes Agent runtime for Nest agents`): the acceptance is a Hermes
 * session that completes a two-turn task with one permission prompt.
 *
 * Hermes Agent speaks ACP (`hermes acp`), so the engine is the ACP client with a Hermes-shaped
 * launch — which is what makes it testable without Hermes itself: a stand-in named `hermes` sits on
 * disk, answers `acp` by running the registry-shaped agent every other engine test uses, and writes
 * down the environment it was handed. That is what this checks that is Hermes' own: the launcher,
 * the model travelling as `HERMES_INFERENCE_MODEL`, and the person's own `HOME` — the whole of
 * Lane B (spec §3.6), since Hermes reads its provider configuration from there and Perch never
 * touches it.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let homesDir = "";
let shimDir = "";
/** Where the stand-in writes the environment it was launched with. */
let envFile = "";
let wasHomesDir: string | undefined;
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
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

type SessionBody = {
  id: string;
  status: string;
  status_message: string | null;
  engine: string;
  engine_session_id: string | null;
  agent: string | null;
  turns: number;
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
  shimDir = mkdtempSync(join(tmpdir(), "perch-hermes-bin-"));
  envFile = join(shimDir, "env.txt");
  const hermes = join(shimDir, "hermes");
  // `hermes acp` and nothing else, the way the real one is launched.
  writeFileSync(
    hermes,
    [
      "#!/bin/sh",
      'if [ "$1" != "acp" ]; then echo "hermes: unknown command $1" >&2; exit 64; fi',
      "shift",
      `env > ${JSON.stringify(envFile)}`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(hermes, 0o755);

  booted = await bootTestApp({}, { sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-hermes-api-"));
  // Per-user homes are the runner's own setting (PERCH_HOMES_DIR, else /data/homes): a hosted
  // runner has them, and Lane B is only true because it does.
  homesDir = mkdtempSync(join(tmpdir(), "perch-hermes-homes-"));
  wasHomesDir = process.env.PERCH_HOMES_DIR;
  process.env.PERCH_HOMES_DIR = homesDir;
  booted.runners.attach(
    createInProcessRunner({
      projectsDir,
      portsIntervalMs: 0,
      sessions: { env: { ...process.env, PERCH_HERMES_COMMAND: `${hermes} acp` } },
    }),
  );
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  if (wasHomesDir === undefined) delete process.env.PERCH_HOMES_DIR;
  else process.env.PERCH_HOMES_DIR = wasHomesDir;
  for (const dir of [projectsDir, homesDir, shimDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sessions on the hermes engine (task 3.8)", () => {
  test("the acceptance: two turns with one permission prompt, on Hermes", async () => {
    const owner = await signUp("Nia", `nia-hermes-${Date.now()}@perch.test`);
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;
    const project = await readyProject(owner.cookie, ws, "Aviary");

    const opened = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, owner.cookie, {
      method: "POST",
      json: {
        engine: "hermes",
        model: { provider: "nous", model_id: "hermes-4-70b" },
        prompt: "edit the notes",
      },
    })) as { status: number; text: string; body: SessionBody };
    expect(opened.status, opened.text).toBe(201);
    const id = opened.body.id;
    expect(opened.body.engine).toBe("hermes");

    // Turn one: it asks before it edits, and the question comes back through the api.
    const waiting = await untilStatus(owner.cookie, id, "needs_you");
    expect(waiting.engine_session_id).toBeTruthy();
    // One engine, one agent: a Hermes session names no program, because there is only the one.
    expect(waiting.agent).toBeNull();
    const answered = await call(`/api/sessions/${id}/permissions/p1`, owner.cookie, {
      method: "POST",
      json: { answer: "allow" },
    });
    expect(answered.status, answered.text).toBe(200);
    await untilStatus(owner.cookie, id, "idle");

    const replay = (await call(`/api/sessions/${id}/events`, owner.cookie)) as { body: EventsBody };
    const types = replay.body.events.map((one) => one.event.type);
    expect(types).toContain("permission");
    expect(types).toContain("tool_result");
    expect(types.at(-1)).toBe("done");
    const notes = join(projectsDir, ws, project, "notes.txt");
    expect(existsSync(notes)).toBe(true);
    expect(readFileSync(notes, "utf8")).toBe("written by the agent\n");

    // Turn two, in plan mode: the same session, the same process, a second answer.
    const second = await call(`/api/sessions/${id}/turns`, owner.cookie, {
      method: "POST",
      json: { text: "mode?", mode: "plan" },
    });
    expect(second.status, second.text).toBe(202);
    const done = await untilStatus(owner.cookie, id, "idle");
    expect(done.turns).toBe(2);
    const tail = (await call(
      `/api/sessions/${id}/events?after_seq=${replay.body.last_seq}`,
      owner.cookie,
    )) as { body: EventsBody };
    expect(tail.body.events.map((one) => one.event.type).at(-1)).toBe("done");
  }, 120_000);

  test("what Hermes was told: its own model, and the person's own home", () => {
    const env = Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split("\n")
        .map((line) => {
          const at = line.indexOf("=");
          return at < 0 ? ["", ""] : [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    // The brain the session runs on, in the variable Hermes documents as `--model`'s equivalent.
    expect(env.HERMES_INFERENCE_MODEL).toBe("hermes-4-70b");
    // Lane B (spec §3.6): Hermes reads ~/.hermes, and ~ is this person's own volume — so a Nous
    // Portal login is theirs and reaches nobody else. Perch put no credential in here at all.
    expect(env.HOME?.startsWith(homesDir)).toBe(true);
    expect(JSON.stringify(env)).not.toContain("PERCH_HERMES_COMMAND");
  });
});
