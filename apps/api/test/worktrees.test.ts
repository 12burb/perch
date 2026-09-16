import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEngine } from "@perch/engines";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.14 (spec §6 `coding_sessions.worktree`, §7.6 `worktree.*`): the acceptance is that two
 * sessions edit the same repository at once and neither sees the other's changes.
 *
 * So this is two work items on one project, each handed to an agent, each agent writing the same
 * filename. The runner is the in-process one of laptop mode and the project is a real git
 * repository on disk, so the worktrees are real worktrees and the isolation is git's, not a mock's.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let cookie = "";
let ws = "";
let project = "";
let projectKey = "";

/** What each agent wrote, by session, so the test can prove they wrote different files. */
const wrote = new Map<string, string>();

/**
 * The agent writes `note.txt` in its own directory. The fake engine has no filesystem of its own,
 * so the turn's text carries the path the runner gave it: what matters here is the directory, and
 * the runner is what decides it.
 */
const fake = new FakeEngine({
  script: (turn, ctx) => {
    wrote.set(ctx.sessionId, turn.text);
    return [{ type: "text", delta: `wrote ${turn.text}` }, { type: "done" }];
  },
});

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
  booted = await bootTestApp({}, { engines: [fake], sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-worktrees-"));
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

type Item = { id: string; identifier: string; state: string; session_id: string | null };

/** Where this project's checkout and its worktrees are on disk. */
function checkout(): string {
  return join(projectsDir, ws, project);
}

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("it never happened");
}

const items: Item[] = [];

describe("a worktree per task (task 3.14)", () => {
  test("a project that is a real repository, and two things to do in it", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-wt-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Worktrees" } })) as {
        body: { id: string };
      }
    ).body.id;

    // An empty project: the runner makes it a real git repository on `main`, which is all a
    // worktree needs. Cloning is task 1.4's and would only add a network to this test.
    const made = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "the-site", source: "empty", default_branch: "main" },
    })) as { status: number; text: string; body: { id: string; key: string } };
    expect(made.status, made.text).toBe(201);
    project = made.body.id;
    projectKey = made.body.key;

    // Wait for the runner to make it a repository, then put a commit in it: a worktree branches
    // from something, and a repository with no commits has nothing to branch from.
    await until(() => existsSync(join(checkout(), ".git")), 60_000);
    writeFileSync(join(checkout(), "README.md"), "# the site\n");
    git(checkout(), "add", ".");
    git(checkout(), "commit", "-m", "first");

    for (const title of ["Fix the header", "Fix the footer"]) {
      const item = (await call(`/api/workspaces/${ws}/projects/${project}/work-items`, {
        method: "POST",
        json: { title },
      })) as { status: number; text: string; body: Item };
      expect(item.status, item.text).toBe(201);
      items.push(item.body);
    }
    expect(items).toHaveLength(2);
  }, 120_000);

  test("the acceptance: two sessions edit the same repository and neither sees the other", async () => {
    const started: string[] = [];
    for (const item of items) {
      const start = (await call(`/api/work-items/${item.id}/start-session`, {
        method: "POST",
        // The prompt is the path the agent would write to; what the test reads is where it is.
        json: { engine: "fake", prompt: "note.txt" },
      })) as { status: number; text: string; body: { session_id: string; item: Item } };
      expect(start.status, start.text).toBe(201);
      started.push(start.body.session_id);
    }
    expect(new Set(started).size).toBe(2);
    await until(() => started.every((id) => wrote.has(id)));

    // Each session is in a worktree of its own, named for its item, and both are on disk at once.
    const sessions = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`)) as {
      body: { sessions: { id: string; worktree: string | null; branch: string | null }[] };
    };
    const rows = sessions.body.sessions.filter((one) => started.includes(one.id));
    expect(rows).toHaveLength(2);
    const branches = rows.map((one) => one.worktree ?? "").sort();
    const [firstBranch = "", secondBranch = ""] = branches;
    expect(branches).toEqual([
      `perch/${projectKey.toLowerCase()}-1`,
      `perch/${projectKey.toLowerCase()}-2`,
    ]);
    for (const row of rows) expect(row.branch).toBe(row.worktree);

    // Two directories, two checkouts of the same repository.
    const dirs = branches.map((branch) =>
      join(`${checkout()}.worktrees`, branch.replace(/\//g, "-")),
    );
    const [first = "", second = ""] = dirs;
    for (const dir of dirs) expect(existsSync(dir)).toBe(true);
    expect(dirs[0]).not.toBe(dirs[1]);

    // And neither sees the other's work: a file written in one is not in the other, nor in the
    // project's own checkout. This is git's isolation, not Perch's.
    writeFileSync(join(first, "note.txt"), "the header is fixed\n");
    expect(existsSync(join(second, "note.txt"))).toBe(false);
    expect(existsSync(join(checkout(), "note.txt"))).toBe(false);
    writeFileSync(join(second, "note.txt"), "the footer is fixed\n");
    expect(readFileSync(join(first, "note.txt"), "utf8")).toContain("header");
    expect(readFileSync(join(second, "note.txt"), "utf8")).toContain("footer");

    // Each is on its own branch, so each is already a pull request waiting to happen.
    expect(git(first, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(firstBranch);
    expect(git(second, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(secondBranch);
  }, 180_000);

  test("closing an item gives its directory back, and keeps its branch", async () => {
    const item = items[0];
    if (!item) throw new Error("no item");
    const branch = `perch/${projectKey.toLowerCase()}-1`;
    const dir = join(`${checkout()}.worktrees`, branch.replace(/\//g, "-"));
    expect(existsSync(dir)).toBe(true);

    const closed = (await call(`/api/work-items/${item.id}`, {
      method: "PATCH",
      json: { state: "done" },
    })) as { status: number; text: string; body: Item };
    expect(closed.status, closed.text).toBe(200);
    await until(() => !existsSync(dir));

    // The branch survives: a checkout is a place to work, not the work.
    expect(git(checkout(), "branch", "--list", branch)).toContain(branch);
    // And the other one is untouched.
    expect(existsSync(join(`${checkout()}.worktrees`, `perch-${projectKey.toLowerCase()}-2`))).toBe(
      true,
    );
  }, 120_000);
});
