import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEngine } from "@perch/engines";
import type { SessionMcpServer } from "@perch/events";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.21 (spec §5.6 "Agent eyes: @playwright/mcp in the runner attached to sessions when a
 * preview is open"): a session gets a browser only while there is a page to look at.
 *
 * The browser itself is not here — which build of `@playwright/mcp` suits a given runner image is
 * that operator's decision (ADR-0139), so the command is configuration. What is under test is the
 * rule: with a dev server up the session is handed the server, with nothing up it is not, and it
 * reaches the engine as a spawned server rather than an HTTP one.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let devServer: ReturnType<typeof Bun.serve> | null = null;
let cookie = "";
let ws = "";
let project = "";

/** What each round was handed, in the order the rounds happened. */
const handed: (SessionMcpServer[] | undefined)[] = [];

const watcher = new FakeEngine({
  id: "watcher",
  script: (_turn, context) => {
    handed.push(context.params.mcpServers);
    return [{ type: "done" }];
  },
});

beforeAll(async () => {
  booted = await bootTestApp(
    { PERCH_PLAYWRIGHT_MCP: "npx -y @playwright/mcp" },
    { engines: [watcher], sessions: { silenceMs: 60_000 } },
  );
  projectsDir = mkdtempSync(join(tmpdir(), "perch-eyes-"));
  // A short scan, because this test is about a port coming up while it is running.
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 250 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 120_000);

afterAll(async () => {
  await running.stop();
  devServer?.stop(true);
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

/** One round on a fresh session, and what the engine was handed for it. */
async function round(): Promise<SessionMcpServer[]> {
  const before = handed.length;
  const made = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
    method: "POST",
    json: { engine: "watcher", prompt: "look at it" },
  })) as { status: number; text: string };
  expect(made.status, made.text).toBe(201);
  await until(() => handed.length > before);
  return handed[before] ?? [];
}

describe("the agent's eyes (task 3.21)", () => {
  test("a project, and nothing running yet", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-eyes-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Eyes" } })) as {
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
  }, 180_000);

  test("with no preview of its own, a session gets no browser", async () => {
    // Something is listening — this test's own api server is — and that is exactly the point: a
    // port being up is not a preview being open.
    const servers = await round();
    expect(servers.some((one) => one.name === "playwright")).toBe(false);
  }, 120_000);

  test("the acceptance: the project's preview comes up, and the next session can see it", async () => {
    devServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("hi") });
    const port = devServer.port;
    mkdirSync(join(projectsDir, ws, project, ".perch"), { recursive: true });
    writeFileSync(
      join(projectsDir, ws, project, ".perch", "project.json"),
      JSON.stringify({ preview: { port } }, null, 2),
    );
    expect(
      (await call(`/api/workspaces/${ws}/projects/${project}/config/reload`, { method: "POST" }))
        .status,
    ).toBe(200);

    // The runner notices it the way it notices any dev server: by looking.
    await until(async () => {
      const seen = (await call(`/api/workspaces/${ws}/projects/${project}/previews`)) as {
        body: { ports: { port: number; runner_id: string; configured: boolean }[] };
      };
      return seen.body.ports.some((one) => one.configured && one.runner_id !== "");
    }, 60_000);

    const servers = await round();
    const eyes = servers.find((one) => one.name === "playwright");
    expect(eyes).toBeDefined();
    // Spawned beside the agent, not fetched: a browser has to be where the page is.
    expect(eyes && "command" in eyes ? eyes.command : "").toBe("npx");
    expect(eyes && "args" in eyes ? eyes.args : []).toEqual(["-y", "@playwright/mcp"]);
    // And it carries nothing that could be a credential.
    expect(JSON.stringify(eyes)).not.toContain("token");
  }, 180_000);
});
