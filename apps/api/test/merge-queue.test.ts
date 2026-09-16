import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEngine } from "@perch/engines";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.15 (spec §5.7 "merge queue with rebase, conflict detection, 'ask the agent to
 * resolve'"): the acceptance is that three branches merge in sequence and the one whose checks
 * fail is sent back with the failure.
 *
 * The repository is real, the worktrees are real, and the project's checks are a real command run
 * through §7.6's `exec` — so what the queue is holding branches to is what the project says its
 * checks are, not a stub. The three branches are written straight into their worktrees, because
 * what is under test is the landing rather than the agent that wrote them.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let cookie = "";
let ws = "";
let project = "";

const fake = new FakeEngine({ script: () => [{ type: "done" }] });

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
  projectsDir = mkdtempSync(join(tmpdir(), "perch-queue-"));
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

type Entry = {
  id: string;
  branch: string;
  state: string;
  position: number;
  failure: string | null;
  detail: string | null;
  head: string | null;
};

function checkout(): string {
  return join(projectsDir, ws, project);
}

function worktree(branch: string): string {
  return join(`${checkout()}.worktrees`, branch.replace(/\//g, "-"));
}

async function until(check: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("it never happened");
}

async function queue(): Promise<Entry[]> {
  const res = (await call(`/api/workspaces/${ws}/projects/${project}/merge-queue`)) as {
    body: { entries: Entry[]; checks: string | null };
  };
  return res.body.entries;
}

/** A branch off main with one file on it, written where the queue will look for it. */
function branchWith(branch: string, file: string, body: string): void {
  git(checkout(), "worktree", "add", "-b", branch, worktree(branch), "main");
  writeFileSync(join(worktree(branch), file), body);
  git(worktree(branch), "add", ".");
  git(worktree(branch), "commit", "-m", `add ${file}`);
}

describe("the merge queue (task 3.15)", () => {
  test("a project whose checks are a real command, and three branches to land", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-queue-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Queue" } })) as {
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
    // And ready: a project still setting up has no runner to answer for it.
    await until(async () => {
      const row = (await call(`/api/workspaces/${ws}/projects/${project}`)) as {
        body: { status: string };
      };
      return row.body.status === "ready";
    }, 60_000);

    // A first commit, so the branches have something to come off.
    writeFileSync(join(checkout(), "README.md"), "# the site\n");
    git(checkout(), "add", "-A");
    git(checkout(), "commit", "-m", "first");

    // The project's checks: every .txt in the repository must say "ok". A branch that adds one
    // saying anything else is a branch that does not land.
    writeFileSync(
      join(checkout(), "check.sh"),
      '#!/bin/sh\nfor f in *.txt; do [ -f "$f" ] || continue; grep -q "^ok$" "$f" || { echo "$f is not ok"; exit 1; }; done\n',
    );
    mkdirSync(join(checkout(), ".perch"), { recursive: true });
    writeFileSync(
      join(checkout(), ".perch", "project.json"),
      JSON.stringify({ run: { check: "sh check.sh" } }, null, 2),
    );
    git(checkout(), "add", "-A");
    git(checkout(), "commit", "-m", "the checks");
    // Perch re-reads .perch/project.json on request (task 2.18), which is how it learns the command.
    expect(
      (await call(`/api/workspaces/${ws}/projects/${project}/config/reload`, { method: "POST" }))
        .status,
    ).toBe(200);
    const shown = (await call(`/api/workspaces/${ws}/projects/${project}/merge-queue`)) as {
      body: { checks: string | null };
    };
    expect(shown.body.checks).toBe("sh check.sh");

    branchWith("perch/one", "one.txt", "ok\n");
    branchWith("perch/two", "two.txt", "not ok\n");
    branchWith("perch/three", "three.txt", "ok\n");
  }, 180_000);

  test("the acceptance: three branches land in order, and the one that fails its checks is sent back", async () => {
    for (const branch of ["perch/one", "perch/two", "perch/three"]) {
      const added = (await call(`/api/workspaces/${ws}/projects/${project}/merge-queue`, {
        method: "POST",
        json: { branch },
      })) as { status: number; text: string; body: Entry };
      expect(added.status, added.text).toBe(201);
    }
    // In the order they were asked for, and each one knows its place.
    expect((await queue()).map((one) => [one.branch, one.position])).toEqual([
      ["perch/one", 1],
      ["perch/two", 2],
      ["perch/three", 3],
    ]);

    await booted.mergeQueue.settled(120_000);
    await until(async () => (await queue()).every((one) => one.state !== "waiting"));
    const done = await queue();
    const byBranch = new Map(done.map((one) => [one.branch, one]));

    // Two landed, in order. The one whose checks failed did not.
    expect(byBranch.get("perch/one")?.state).toBe("landed");
    expect(byBranch.get("perch/two")?.state).toBe("failed");
    expect(byBranch.get("perch/three")?.state).toBe("landed");

    // And it was sent back with the failure: the command, and what it said.
    expect(byBranch.get("perch/two")?.failure).toBe("checks");
    expect(byBranch.get("perch/two")?.detail).toContain("sh check.sh");
    expect(byBranch.get("perch/two")?.detail).toContain("two.txt is not ok");

    // The base really moved, twice, and carries both files and neither of the bad one's.
    git(checkout(), "checkout", "main");
    const files = git(checkout(), "ls-tree", "--name-only", "HEAD");
    expect(files).toContain("one.txt");
    expect(files).toContain("three.txt");
    expect(files).not.toContain("two.txt");
    // Landed means fast-forwarded onto main: the head the entry reported is main's head.
    expect(git(checkout(), "rev-parse", "HEAD").trim()).toBe(
      byBranch.get("perch/three")?.head ?? "",
    );

    // A queue is not a stop sign: the third landed even though the second did not.
    const three = byBranch.get("perch/three");
    expect(three?.position).toBe(3);
    expect(three?.head).toMatch(/^[0-9a-f]{40}$/);
  }, 300_000);

  test("a branch that will not rebase is a conflict, not a crash", async () => {
    // Two branches adding the same file with different words, so the second cannot rebase onto
    // the first. Not a `.txt`: the project's checks are about those, and this is about git.
    for (const [branch, body] of [
      ["perch/left", "left\n"],
      ["perch/right", "right\n"],
    ] as const) {
      branchWith(branch, "same.md", body);
    }
    for (const branch of ["perch/left", "perch/right"]) {
      expect(
        (
          await call(`/api/workspaces/${ws}/projects/${project}/merge-queue`, {
            method: "POST",
            json: { branch },
          })
        ).status,
      ).toBe(201);
    }
    await booted.mergeQueue.settled(120_000);
    await until(async () =>
      (await queue())
        .filter((one) => one.branch.startsWith("perch/le") || one.branch.startsWith("perch/ri"))
        .every((one) => one.state !== "waiting" && one.state !== "landing"),
    );
    const byBranch = new Map((await queue()).map((one) => [one.branch, one]));
    expect(byBranch.get("perch/left")?.state).toBe("landed");
    expect(byBranch.get("perch/right")?.state).toBe("failed");
    expect(byBranch.get("perch/right")?.failure).toBe("conflict");
    expect(byBranch.get("perch/right")?.detail).toMatch(/\S/);

    // The base is whole: a failed rebase left nothing half-applied.
    git(checkout(), "checkout", "main");
    expect(git(checkout(), "status", "--porcelain").trim()).toBe("");
  }, 300_000);

  test("the same branch twice is the place it already had", async () => {
    branchWith("perch/again", "again.txt", "ok\n");
    const first = (await call(`/api/workspaces/${ws}/projects/${project}/merge-queue`, {
      method: "POST",
      json: { branch: "perch/again" },
    })) as { body: Entry };
    const second = (await call(`/api/workspaces/${ws}/projects/${project}/merge-queue`, {
      method: "POST",
      json: { branch: "perch/again" },
    })) as { body: Entry };
    // Either the same row, or it already landed between the two calls — never a second place.
    if (second.body.state === "waiting" || second.body.state === "landing") {
      expect(second.body.id).toBe(first.body.id);
    }
    await booted.mergeQueue.settled(120_000);
  }, 180_000);
});
