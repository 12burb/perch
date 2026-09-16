import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEngine } from "@perch/engines";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";
import { captureSpans, releaseSpans } from "./fixtures/spans.ts";

/**
 * Task 3.22 (spec §8 "OpenTelemetry SDK, OTLP export off by default"; §5.7 "OTel traces and cost
 * per task"): one trace per session round with a span for every model call, tool call and runner
 * RPC, and cost rolled up to the work item.
 *
 * The exporter is in memory rather than a collector: what is under test is which spans Perch
 * makes and what it hangs on them, and a collector would only be somewhere to post them to.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let cookie = "";
let ws = "";
let project = "";

let spans: ReturnType<typeof captureSpans>;

const worker = new FakeEngine({
  id: "worker",
  script: () => [
    { type: "tool_call", id: "r", name: "Read README.md", args: {} },
    { type: "tool_result", id: "r", output: "# hi" },
    {
      type: "tool_call",
      id: "w",
      name: "Write notes.md",
      args: {},
    },
    {
      type: "tool_result",
      id: "w",
      output: "wrote",
      diff: [{ path: "notes.md", patch: "+a\n", additions: 1, deletions: 0, status: "added" }],
    },
    { type: "usage", input: 120, output: 40, costUsd: 0.37 },
    { type: "done" },
  ],
});

beforeAll(async () => {
  spans = captureSpans();
  booted = await bootTestApp({}, { engines: [worker], sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-traces-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 120_000);

afterAll(async () => {
  releaseSpans();
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

async function until(check: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("it never happened");
}

function named(name: string) {
  return spans.getFinishedSpans().filter((one) => one.name === name);
}

/**
 * This test's own spans. Every file in the suite exports into the one process-wide exporter, so a
 * span is only this test's if it carries this test's ids — `named(...)[0]` is some other file's
 * project.
 */
function ours(name: string, key: string, id: () => string) {
  return named(name).filter((one) => one.attributes[key] === id());
}

let item = "";

describe("traces and cost (task 3.22)", () => {
  test("a project, and a work item to do in it", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-traces-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Traces" } })) as {
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

    // Every runner RPC is a span, and the clone is made of them.
    const setups = ours("runner.project.setup", "perch.project_id", () => project);
    expect(setups.length).toBeGreaterThan(0);
    const setup = setups[0];
    expect(setup?.attributes["rpc.method"]).toBe("project.setup");
    expect(setup?.attributes["perch.workspace_id"]).toBe(ws);

    const born = (await call(`/api/workspaces/${ws}/projects/${project}/work-items`, {
      method: "POST",
      json: { title: "Make it go" },
    })) as { status: number; text: string; body: { id: string } };
    expect(born.status, born.text).toBe(201);
    item = born.body.id;
  }, 180_000);

  test("the acceptance: a finished item says what it cost and where the time went", async () => {
    const started = (await call(`/api/work-items/${item}/start-session`, {
      method: "POST",
      json: { engine: "worker", prompt: "have a go" },
    })) as { status: number; text: string; body: { session_id: string } };
    expect(started.status, started.text).toBe(201);

    // The item's session settles by itself (ADR-0133), which is what finishes the item.
    await until(async () => {
      const row = (await call(`/api/sessions/${started.body.session_id}`)) as {
        body: { status: string };
      };
      return row.body.status === "ended";
    }, 120_000);

    const rolled = (await call(`/api/work-items/${item}/cost`)) as {
      status: number;
      text: string;
      body: {
        cost_usd: number;
        elapsed_ms: number;
        working_ms: number;
        turns: number;
        sessions: { id: string; engine: string; cost_usd: number; elapsed_ms: number }[];
      };
    };
    expect(rolled.status, rolled.text).toBe(200);
    expect(rolled.body.cost_usd).toBeCloseTo(0.37, 2);
    expect(rolled.body.turns).toBe(1);
    expect(rolled.body.sessions).toHaveLength(1);
    expect(rolled.body.sessions[0]?.engine).toBe("worker");
    expect(rolled.body.sessions[0]?.cost_usd).toBeCloseTo(0.37, 2);
    // Where the time went: the item's own clock, and the part of it a session was running.
    expect(rolled.body.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(rolled.body.working_ms).toBeGreaterThanOrEqual(0);
  }, 300_000);

  test("one trace per round: the round, its tools, and what it cost", async () => {
    const rounds = ours("session.round", "perch.work_item_id", () => item);
    expect(rounds.length).toBeGreaterThan(0);
    const round = rounds.at(-1);
    expect(round?.attributes["perch.engine"]).toBe("worker");
    expect(round?.attributes["perch.work_item_id"]).toBe(item);
    // Usage lands on the round, which is where "what did this cost" is asked.
    expect(round?.attributes["perch.cost_usd"]).toBeCloseTo(0.37, 2);
    expect(round?.attributes["perch.input_tokens"]).toBe(120);

    // A span per tool call, named for the tool, ended by its own result — and inside the round
    // rather than beside it, which is what makes the trace worth reading.
    const tools = spans
      .getFinishedSpans()
      .filter(
        (one) =>
          one.name.startsWith("tool.") &&
          one.parentSpanContext?.spanId === round?.spanContext().spanId,
      );
    expect(tools.map((one) => one.name)).toContain("tool.Read README.md");
    const wrote = tools.find((one) => one.name === "tool.Write notes.md");
    expect(wrote?.attributes["perch.files_changed"]).toBe(1);
  }, 120_000);

  test("nothing traced carries anything but ids and small facts", () => {
    for (const one of spans.getFinishedSpans()) {
      for (const [key, value] of Object.entries(one.attributes)) {
        // No prompt, no output, no file content — the same rule the log lines follow (§9.1).
        expect(key).not.toContain("prompt");
        expect(key).not.toContain("content");
        expect(String(value)).not.toContain("have a go");
      }
    }
  });
});
