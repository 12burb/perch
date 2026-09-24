import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner } from "@perch/runner";
import { STACKS } from "@perch/templates";
import type { Booted } from "../src/boot.ts";
import { projectDeps } from "../src/routes/projects.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { DEMO_CHANNELS, demoDepsFrom, seedDemo, welcome } from "../src/services/demo.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Starter stacks, a project made from one, and the demo workspace (task 4.8).
 *
 * The acceptance is the whole chain: the catalogue is served, a project made from a template comes
 * up with the stack's files and the stack's `.perch/project.json` already read, pressing Start runs
 * the command the project itself named and the port answers, and the demo seeds a workspace that
 * has something in it.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let ws = "";
let cookie = "";
let userId = "";

beforeAll(async () => {
  booted = await bootTestApp();
  projectsDir = mkdtempSync(join(tmpdir(), "perch-templates-"));
  // The ports poller is what tells the api a dev server came up (task 1.18).
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 250 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  const signed = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      name: "Ada",
      email: `ada-templates-${Date.now()}@perch.test`,
      password: "correct horse battery staple",
    }),
  });
  expect(signed.status).toBe(200);
  cookie = signed.headers
    .getSetCookie()
    .map((one) => one.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
  const me = (await call("/api/me")) as { body: { id: string } };
  userId = me.body.id;
  const made = (await call("/api/workspaces", {
    method: "POST",
    json: { name: "Stack Nest" },
  })) as {
    body: { id: string };
  };
  ws = made.body.id;
}, 60_000);

afterAll(async () => {
  await running.stop();
  rmSync(projectsDir, { recursive: true, force: true });
});

async function call(path: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

type ProjectBody = {
  id: string;
  key: string;
  source: string;
  status: string;
  status_message: string | null;
  config: { preview?: { port?: number; command?: string } };
  actions: { id: string; command: string | null }[];
};

async function ready(id: string): Promise<ProjectBody> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = (await call(`/api/workspaces/${ws}/projects/${id}`)) as { body: ProjectBody };
    if (res.body.status === "ready" || res.body.status === "error") return res.body;
    if (Date.now() > deadline) throw new Error(`project stayed ${res.body.status}`);
    await Bun.sleep(100);
  }
}

describe("starter stacks (task 4.8)", () => {
  test("the catalogue is every stack in the build", async () => {
    const res = (await call("/api/templates")) as {
      status: number;
      body: { templates: { id: string; port: number; dev: string; files: number }[] };
    };
    expect(res.status).toBe(200);
    expect(res.body.templates.map((one) => one.id)).toEqual(STACKS.map((one) => one.id));
    for (const one of res.body.templates) {
      expect(one.files, one.id).toBeGreaterThan(2);
      expect(one.port, one.id).toBeGreaterThan(0);
      expect(one.dev, one.id).toMatch(/\S/);
    }
  });

  test("nobody signed in does not see the catalogue", async () => {
    const res = await fetch(`${base}/api/templates`);
    expect(res.status).toBe(403);
  });

  test("a project made from a stack has its files and its config, and Start runs it", async () => {
    const created = (await call(`/api/workspaces/${ws}/projects/template`, {
      method: "POST",
      json: { name: "Birdsong", template: "bun-api" },
    })) as { status: number; body: ProjectBody };
    expect(created.status).toBe(201);
    expect(created.body.source).toBe("template");
    const project = await ready(created.body.id);
    expect(project.status, project.status_message ?? "").toBe("ready");

    // The stack's files really landed, on disk where the runner put them.
    const dir = join(projectsDir, ws, project.id);
    expect(readFileSync(join(dir, "src", "index.ts"), "utf8")).toContain("Bun.serve");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("Perch");

    // …and Perch read the `.perch/project.json` the stack brought with it, without being asked.
    expect(project.config.preview?.port).toBe(3000);
    expect(project.config.preview?.command).toBe("bun --hot src/index.ts");
    expect(project.actions.find((one) => one.id === "dev")?.command).toBe("bun --hot src/index.ts");

    // The preview says what the project starts with, and nothing is on the port yet.
    const before = (await call(`/api/workspaces/${ws}/projects/${project.id}/previews`)) as {
      body: { ports: { port: number; runner_id: string }[]; config: { command: string | null } };
    };
    expect(before.body.config.command).toBe("bun --hot src/index.ts");
    expect(before.body.ports.find((one) => one.port === 3000)?.runner_id).toBe("");

    // One press, and the dev server is up on the port the project named.
    const started = (await call(`/api/workspaces/${ws}/projects/${project.id}/previews/start`, {
      method: "POST",
    })) as {
      status: number;
      body: { running: boolean; started: boolean; serving: boolean; port: number; log: string };
    };
    expect(started.status, started.body.log).toBe(200);
    expect(started.body.started).toBe(true);
    expect(started.body.serving, started.body.log).toBe(true);
    expect(started.body.port).toBe(3000);

    // It is really serving: the stack's own page and its own endpoint both answer.
    const page = await fetch("http://127.0.0.1:3000/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="app"');
    const answer = await fetch("http://127.0.0.1:3000/health");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ ok: true });

    // Pressing it again is not a second dev server.
    const again = (await call(`/api/workspaces/${ws}/projects/${project.id}/previews/start`, {
      method: "POST",
    })) as { body: { started: boolean; serving: boolean } };
    expect(again.body.started).toBe(false);
    expect(again.body.serving).toBe(true);

    const stopped = (await call(`/api/workspaces/${ws}/projects/${project.id}/previews/stop`, {
      method: "POST",
    })) as { status: number; body: { running: boolean; serving: boolean } };
    expect(stopped.status).toBe(200);
    expect(stopped.body.running).toBe(false);
    expect(stopped.body.serving).toBe(false);
    await expect(fetch("http://127.0.0.1:3000/health")).rejects.toThrow();
  }, 180_000);

  test("a template nobody has is refused before a row is written", async () => {
    const res = await call(`/api/workspaces/${ws}/projects/template`, {
      method: "POST",
      json: { name: "Nope", template: "not-a-stack" },
    });
    expect(res.status).toBe(422);
    const list = (await call(`/api/workspaces/${ws}/projects`)) as {
      body: { projects: { name: string }[] };
    };
    expect(list.body.projects.some((one) => one.name === "Nope")).toBe(false);
  });

  test("a project with no preview command cannot be started", async () => {
    const created = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "Bare" },
    })) as { body: ProjectBody };
    const project = await ready(created.body.id);
    expect(project.status).toBe("ready");
    const res = await call(`/api/workspaces/${ws}/projects/${project.id}/previews/start`, {
      method: "POST",
    });
    expect(res.status).toBe(422);
    expect(res.text).toContain("preview.command");
  }, 120_000);
});

describe("the demo workspace (task 4.8)", () => {
  test("it seeds channels and bots, and running it twice changes nothing", async () => {
    const deps = demoDepsFrom(projectDeps(booted), booted.bots);
    const by = { actor: { type: "user" as const, id: userId }, meta: {} };
    const first = await seedDemo(deps, { workspaceId: ws, userId, by, project: false });
    expect(first.channels.map((one) => one.name)).toEqual(DEMO_CHANNELS.map((one) => one.name));
    expect(first.channels.every((one) => one.created)).toBe(true);
    expect(first.bots.map((one) => one.handle).length).toBe(2);
    expect(first.bots.every((one) => one.created)).toBe(true);

    const again = await seedDemo(deps, { workspaceId: ws, userId, by, project: false });
    expect(again.channels.every((one) => one.created)).toBe(false);
    expect(again.bots.every((one) => one.created)).toBe(false);

    // They are real rows, reachable the way anything else in the workspace is.
    const channels = (await call(`/api/workspaces/${ws}/channels`)) as {
      body: { channels: { name: string | null }[] };
    };
    const names = channels.body.channels.map((one) => one.name);
    for (const { name } of DEMO_CHANNELS) expect(names).toContain(name);
    const bots = (await call(`/api/workspaces/${ws}/bots`)) as {
      body: { bots: { handle: string; channels: string[] }[] };
    };
    expect(bots.body.bots.length).toBeGreaterThanOrEqual(2);
    // Each bot is in the rooms the demo made for talking to them, so a brain is all it lacks
    // (code review, ADR-0176).
    const rooms = channels.body.channels as { id?: string; name: string | null }[];
    const idOf = (name: string) => rooms.find((one) => one.name === name)?.id ?? "";
    for (const handle of first.bots.map((one) => one.handle)) {
      const bot = bots.body.bots.find((one) => one.handle === handle);
      expect(bot?.channels).toContain(idOf("general"));
      expect(bot?.channels).toContain(idOf("the-nest"));
    }

    // …and #general opens with a message that says what is here.
    const general = channels.body.channels.find((one) => one.name === "general");
    expect(general).toBeDefined();
  }, 120_000);

  test("the welcome message says what was made", () => {
    const text = welcome({
      channels: [{ name: "general", created: true }],
      bots: [{ handle: "helpdesk", created: true }],
      project: { id: "x", key: "bun-api", created: true, status: "ready" },
      preview: { port: 3000, serving: true },
    });
    expect(text).toContain("#general");
    expect(text).toContain("@helpdesk");
    expect(text).toContain("port 3000");
  });
});
