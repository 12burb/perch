import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner, findBrowser } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.21 (spec §5.6 "Preflight before push: run test/lint/build from project.json, then an agent
 * visual smoke over the configured routes (screenshot each, fail on console errors) → checklist
 * card; configurable warn or block"): the acceptance is that an agent screenshots its own change
 * before reporting done — which here is a push that will not go out because the page it would ship
 * throws on load.
 *
 * The page is real, served by a real dev server, and looked at by a real browser. A test that stubs
 * the browser would be a test of the stub: the whole point of a visual smoke is that it sees what a
 * suite cannot.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let dev: ReturnType<typeof Bun.serve> | null = null;
let cookie = "";
let ws = "";
let project = "";
/** What the dev server currently serves at `/`. */
let page = "<!doctype html><html><body><h1>fine</h1></body></html>";

const browser = findBrowser();

function checkout(): string {
  return join(projectsDir, ws, project);
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
  dev = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      // Every dev server does this, and every browser asks: a page with no favicon is not a page
      // that fails (task 3.21).
      if (new URL(request.url).pathname === "/favicon.ico") {
        return new Response("no", { status: 404 });
      }
      return new Response(page, { headers: { "content-type": "text/html" } });
    },
  });
  booted = await bootTestApp({});
  projectsDir = mkdtempSync(join(tmpdir(), "perch-preflight-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 250 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 120_000);

afterAll(async () => {
  await running.stop();
  dev?.stop(true);
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

type Row = { name: string; kind: string; ok: boolean; detail?: string };

/** Write the project's config and have Perch re-read it. */
async function configure(config: unknown): Promise<void> {
  mkdirSync(join(checkout(), ".perch"), { recursive: true });
  writeFileSync(join(checkout(), ".perch", "project.json"), JSON.stringify(config, null, 2));
  expect(
    (await call(`/api/workspaces/${ws}/projects/${project}/config/reload`, { method: "POST" }))
      .status,
  ).toBe(200);
}

describe("preflight before push (task 3.21)", () => {
  test("a project whose preview is up, and whose commands it names", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-preflight-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Preflight" } })) as {
        body: { id: string };
      }
    ).body.id;
    const made = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "the-site", source: "empty", default_branch: "main" },
    })) as { status: number; text: string; body: { id: string } };
    expect(made.status, made.text).toBe(201);
    project = made.body.id;
    await until(() => existsSync(join(checkout(), ".git")));
    await until(async () => {
      const row = (await call(`/api/workspaces/${ws}/projects/${project}`)) as {
        body: { status: string };
      };
      return row.body.status === "ready";
    }, 60_000);

    writeFileSync(join(checkout(), "lint.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(checkout(), "test.sh"), "#!/bin/sh\necho 'a test failed'; exit 1\n");
    await configure({
      run: { lint: "sh lint.sh", test: "sh test.sh" },
      preview: { port: dev?.port ?? 0, routes: ["/"], preflight: "block" },
    });
    git(checkout(), "add", "-A");
    git(checkout(), "commit", "-m", "first");
  }, 180_000);

  test("the project's own commands are the first half of it", async () => {
    const ran = (await call(`/api/workspaces/${ws}/projects/${project}/preflight`, {
      method: "POST",
      json: {},
    })) as { status: number; text: string; body: { passed: boolean; rows: Row[] } };
    expect(ran.status, ran.text).toBe(200);
    const byName = new Map(ran.body.rows.map((one) => [one.name, one]));
    expect(byName.get("lint: sh lint.sh")?.ok).toBe(true);
    // A failing command fails preflight, and says what it said.
    expect(byName.get("test: sh test.sh")?.ok).toBe(false);
    expect(byName.get("test: sh test.sh")?.detail).toContain("a test failed");
    expect(ran.body.passed).toBe(false);
  }, 180_000);

  // Skipped where there is no browser, and CI says there must be one (PERCH_REQUIRE_BROWSER, set
  // by the job that installs it), so the acceptance cannot go quietly missing from every run.
  test.skipIf(!process.env.PERCH_REQUIRE_BROWSER)("the browser CI installed is found", () => {
    expect(browser).not.toBeNull();
  });

  test.skipIf(!browser)(
    "the acceptance: a page that throws is caught by looking at it, and the push is blocked",
    async () => {
      // The commands pass now: what is under test is the half a suite cannot do.
      writeFileSync(join(checkout(), "test.sh"), "#!/bin/sh\nexit 0\n");
      page = `<!doctype html><html><body><h1>shipping</h1><script>
        brokenOnLoad();
      </script></body></html>`;
      await until(async () => {
        const seen = (await call(`/api/workspaces/${ws}/projects/${project}/previews`)) as {
          body: { ports: { configured: boolean; runner_id: string }[] };
        };
        return seen.body.ports.some((one) => one.configured && one.runner_id !== "");
      }, 60_000);

      const ran = (await call(`/api/workspaces/${ws}/projects/${project}/preflight`, {
        method: "POST",
        json: {},
      })) as { status: number; text: string; body: { passed: boolean; rows: Row[] } };
      expect(ran.status, ran.text).toBe(200);
      const route = ran.body.rows.find((one) => one.kind === "route" && one.name === "/");
      expect(route?.ok).toBe(false);
      expect(route?.detail).toContain("brokenOnLoad");
      expect(ran.body.passed).toBe(false);

      // And a `block` project does not push on that.
      const refused = (await call(`/api/workspaces/${ws}/projects/${project}/git/push`, {
        method: "POST",
        json: {},
      })) as { status: number; text: string };
      expect(refused.status).toBe(409);
      expect(refused.text).toContain("preflight");

      // A page that does not throw passes — the browser's own 404 for the favicon nobody added is
      // not the page's failure — and the same push gets as far as git.
      page = "<!doctype html><html><body><h1>fine</h1></body></html>";
      const again = (await call(`/api/workspaces/${ws}/projects/${project}/preflight`, {
        method: "POST",
        json: {},
      })) as { body: { passed: boolean; rows: Row[] } };
      expect(again.body.passed).toBe(true);
      const pushed = await call(`/api/workspaces/${ws}/projects/${project}/git/push`, {
        method: "POST",
        json: {},
      });
      // No remote on this project, so git refuses — but preflight did not, which is the point.
      expect(pushed.status).not.toBe(409);
    },
    300_000,
  );

  test("a project that says nothing about preflight pushes without one", async () => {
    await configure({ run: { lint: "sh lint.sh" } });
    const pushed = (await call(`/api/workspaces/${ws}/projects/${project}/git/push`, {
      method: "POST",
      json: {},
    })) as { status: number; text: string; body: { preflight?: unknown } };
    expect(pushed.status).not.toBe(409);
    expect(pushed.body?.preflight).toBeUndefined();
  }, 120_000);
});
