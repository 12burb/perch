import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEngine } from "@perch/engines";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.18 (spec §5.7 "testing loop: failing tests → bounded auto-fix loop with budget"): the
 * acceptance is that an agent breaks a test, is told, and fixes it without anybody typing.
 *
 * Both engines here are stubborn in a useful way. `fixer` writes the wrong answer first and the
 * right one when it is told; `stubborn` writes the wrong answer every time, which is what the
 * bound is for. The tests are a real command run through §7.6's `exec`, in the project's own
 * checkout, so what the loop is holding the agent to is what the project says its tests are.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let cookie = "";
let ws = "";
let channel = "";

function checkout(project: string): string {
  return join(projectsDir, ws, project);
}

/** Where the current project's files go. Set once the project exists. */
let where = "";

/**
 * An engine that writes an answer into the checkout. `fixer` gets it right the moment it is told
 * anything at all; `stubborn` never does.
 */
function engine(id: string, answers: (round: number) => string) {
  return new FakeEngine({
    id,
    script: (_turn, context) => {
      const answer = answers(context.round);
      writeFileSync(join(where, "answer.txt"), `${answer}\n`);
      return [
        {
          type: "tool_result",
          id: `w${context.round}`,
          output: "wrote answer.txt",
          diff: [
            {
              path: "answer.txt",
              patch: `+${answer}\n`,
              additions: 1,
              deletions: 0,
              status: "modified",
            },
          ],
        },
        { type: "usage", input: 5, output: 5, costUsd: 0.01 },
        { type: "done" },
      ];
    },
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Perch",
      GIT_AUTHOR_EMAIL: "perch@perch.test",
      GIT_COMMITTER_NAME: "Perch",
      GIT_COMMITTER_EMAIL: "perch@perch.test",
    },
  });
}

beforeAll(async () => {
  booted = await bootTestApp(
    {},
    {
      engines: [
        engine("fixer", (round) => (round <= 1 ? "41" : "42")),
        engine("stubborn", () => "41"),
      ],
      sessions: { silenceMs: 60_000 },
    },
  );
  projectsDir = mkdtempSync(join(tmpdir(), "perch-loop-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 120_000);

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

async function until(check: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("it never happened");
}

type Event = { seq: number; event: { type: string; text?: string; userId?: string } };

async function turnsOf(session: string): Promise<string[]> {
  const res = (await call(`/api/sessions/${session}/events`)) as { body: { events: Event[] } };
  return res.body.events
    .filter((one) => one.event.type === "turn")
    .map((one) => one.event.text ?? "");
}

async function status(session: string): Promise<string> {
  const res = (await call(`/api/sessions/${session}`)) as { body: { status: string } };
  return res.body.status;
}

/**
 * A project whose tests want `42` in answer.txt, with the loop turned on. Returns its id, and
 * leaves `where` pointing at its checkout.
 */
async function project(name: string, attempts?: number): Promise<string> {
  const made = (await call(`/api/workspaces/${ws}/projects`, {
    method: "POST",
    json: { name, source: "empty", default_branch: "main" },
  })) as { status: number; text: string; body: { id: string } };
  expect(made.status, made.text).toBe(201);
  const id = made.body.id;
  where = checkout(id);
  await until(() => existsSync(join(where, ".git")));
  await until(async () => {
    const row = (await call(`/api/workspaces/${ws}/projects/${id}`)) as {
      body: { status: string };
    };
    return row.body.status === "ready";
  }, 60_000);

  writeFileSync(
    join(where, "test.sh"),
    '#!/bin/sh\ngrep -q "^42$" answer.txt || { echo "answer.txt is not 42"; exit 1; }\n',
  );
  writeFileSync(join(where, "answer.txt"), "42\n");
  mkdirSync(join(where, ".perch"), { recursive: true });
  writeFileSync(
    join(where, ".perch", "project.json"),
    JSON.stringify(
      {
        run: { test: "sh test.sh" },
        background: { testLoop: { ...(attempts === undefined ? {} : { attempts }) } },
      },
      null,
      2,
    ),
  );
  git(where, "add", "-A");
  git(where, "commit", "-m", "first");
  expect(
    (await call(`/api/workspaces/${ws}/projects/${id}/config/reload`, { method: "POST" })).status,
  ).toBe(200);
  return id;
}

describe("the testing loop (task 3.18)", () => {
  test("a workspace and a channel for the runs to report in", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-loop-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Loop" } })) as {
        body: { id: string };
      }
    ).body.id;
    channel = (
      (await call(`/api/workspaces/${ws}/channels`, {
        method: "POST",
        json: { name: "loop", kind: "public" },
      })) as { body: { id: string } }
    ).body.id;
  }, 180_000);

  test("the acceptance: an agent breaks a test, is told, and fixes it without anybody typing", async () => {
    const id = await project("fixable");
    const started = (await call(`/api/workspaces/${ws}/projects/${id}/sessions/background`, {
      method: "POST",
      json: { prompt: "set the answer", engine: "fixer", channel_id: channel },
    })) as { status: number; text: string; body: { id: string } };
    expect(started.status, started.text).toBe(201);
    const session = started.body.id;

    // It finishes by itself, which with a passing test is the end of the loop.
    await until(async () => (await status(session)) === "ended", 120_000);

    const turns = await turnsOf(session);
    // Two turns: the one a person asked for, and the one the loop sent. Nobody typed the second.
    expect(turns).toHaveLength(2);
    expect(turns[0]).toBe("set the answer");
    expect(turns[1]).toContain("sh test.sh");
    expect(turns[1]).toContain("answer.txt is not 42");

    // And the file on disk is the fixed one: the second turn really ran.
    expect(readFileSync(join(checkout(id), "answer.txt"), "utf8").trim()).toBe("42");
  }, 300_000);

  test("the bound: an agent that will not fix it stops and asks a person", async () => {
    const id = await project("stubborn-project", 2);
    const started = (await call(`/api/workspaces/${ws}/projects/${id}/sessions/background`, {
      method: "POST",
      json: { prompt: "set the answer", engine: "stubborn", channel_id: channel },
    })) as { status: number; text: string; body: { id: string } };
    expect(started.status, started.text).toBe(201);
    const session = started.body.id;

    await until(async () => (await status(session)) === "needs_you", 120_000);
    // The first turn, then two the loop sent, and then it stopped asking.
    const turns = await turnsOf(session);
    expect(turns).toHaveLength(3);
    for (const told of turns.slice(1)) expect(told).toContain("answer.txt is not 42");

    // It stays stopped: a bound that is not a bound is an agent burning somebody's money.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await turnsOf(session)).toHaveLength(3);
    expect(await status(session)).toBe("needs_you");

    // And it said so where a person will see it, rather than only in the session.
    const messages = (await call(
      `/api/workspaces/${ws}/channels/${channel}/messages?limit=100`,
    )) as { body: { messages: { blocks: Record<string, unknown>[] }[] } };
    const card = messages.body.messages
      .flatMap((one) => one.blocks)
      .find((block) => block.type === "background_card" && block.state === "needs_you");
    expect(card).toBeDefined();
    expect(String(card?.detail ?? "")).toContain("answer.txt is not 42");
  }, 300_000);

  test("a project that says nothing about tests is left alone", async () => {
    const made = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "quiet", source: "empty", default_branch: "main" },
    })) as { body: { id: string } };
    const id = made.body.id;
    where = checkout(id);
    await until(async () => {
      const row = (await call(`/api/workspaces/${ws}/projects/${id}`)) as {
        body: { status: string };
      };
      return row.body.status === "ready";
    }, 60_000);

    const started = (await call(`/api/workspaces/${ws}/projects/${id}/sessions/background`, {
      method: "POST",
      json: { prompt: "set the answer", engine: "stubborn", channel_id: channel },
    })) as { body: { id: string } };
    await until(async () => (await status(started.body.id)) === "ended", 120_000);
    expect(await turnsOf(started.body.id)).toHaveLength(1);
  }, 300_000);
});
