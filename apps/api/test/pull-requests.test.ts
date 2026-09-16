import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEngine } from "@perch/engines";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";
import { generateAppKey, type StandInGitHub, startStandInGitHub } from "./fixtures/github.ts";

/**
 * Task 3.20 (spec §5.1 "Pull Requests page in Phase 3 with inline comments, request changes, 'ask
 * the agent to address review'"): the acceptance is that a review comment becomes a turn and the
 * push answers it.
 *
 * The repository is real and so is the clone, the branch and the push — the stand-in GitHub serves
 * git's own smart protocol. What it stands in for is the review, because a review is somebody's
 * opinion and there is nobody here to have one.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let github: StandInGitHub;
let appKeyPem = "";
let cookie = "";
let ws = "";
let project = "";
let connection = "";

const BRANCH = "perch/answer";

/** It writes into the checkout it was given, which for this session is the branch's worktree. */
const fixer = new FakeEngine({
  id: "fixer",
  script: (turn, context) => {
    const dir = worktree(context.params.worktree ?? "");
    // It only knows what to write because the turn told it: the review is the instruction.
    const wanted = /should be (\d+)/.exec(turn.text)?.[1] ?? "?";
    writeFileSync(join(dir, "answer.txt"), `${wanted}\n`);
    return [
      {
        type: "tool_result",
        id: "w",
        output: "wrote answer.txt",
        diff: [
          {
            path: "answer.txt",
            patch: `+${wanted}\n`,
            additions: 1,
            deletions: 1,
            status: "modified",
          },
        ],
      },
      { type: "done" },
    ];
  },
});

function checkout(): string {
  return join(projectsDir, ws, project);
}

function worktree(branch: string): string {
  return join(`${checkout()}.worktrees`, branch.replace(/\//g, "-"));
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
  github = await startStandInGitHub({ files: { "answer.txt": "?\n", "README.md": "# it\n" } });
  appKeyPem = await generateAppKey();
  booted = await bootTestApp({}, { engines: [fixer], sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-prs-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 120_000);

afterAll(async () => {
  await running.stop();
  github.stop();
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

describe("the Pull Requests page (task 3.20)", () => {
  test("a cloned project, a branch, and a review waiting on it", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-prs-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Reviews" } })) as {
        body: { id: string };
      }
    ).body.id;

    const made = (await call(`/api/workspaces/${ws}/connections`, {
      method: "POST",
      json: {
        kind: "github_app",
        provider: "github",
        app_id: "424242",
        private_key: appKeyPem,
        installation_id: "77",
        api_base: github.url,
      },
    })) as { status: number; text: string; body: { id: string } };
    expect(made.status, made.text).toBe(201);
    connection = made.body.id;

    const cloned = (await call(`/api/workspaces/${ws}/projects/clone`, {
      method: "POST",
      json: {
        name: "cloned",
        repo_url: github.repoUrl,
        auth: { kind: "connection", connection_id: connection },
      },
    })) as { status: number; text: string; body: { id: string } };
    expect(cloned.status, cloned.text).toBe(201);
    project = cloned.body.id;
    await until(async () => {
      const row = (await call(`/api/workspaces/${ws}/projects/${project}`)) as {
        body: { status: string; status_message: string | null };
      };
      if (row.body.status === "error") throw new Error(row.body.status_message ?? "clone failed");
      return row.body.status === "ready";
    }, 60_000);

    // The branch a session would have left: the answer, still wrong.
    git(checkout(), "checkout", "-b", BRANCH);
    writeFileSync(join(checkout(), "answer.txt"), "41\n");
    git(checkout(), "commit", "-am", "an answer");
    const sha = git(checkout(), "rev-parse", "HEAD").trim();
    git(checkout(), "checkout", "main");

    // And the review that is waiting on it, with one comment on one line.
    github.pulls.set(7, {
      number: 7,
      title: "An answer",
      branch: BRANCH,
      sha,
      body: "Adds the answer.",
      comments: [
        { id: 11, path: "answer.txt", line: 1, body: "this should be 42", author: "wren" },
      ],
      reviews: [
        { id: 21, state: "CHANGES_REQUESTED", body: "Nearly.", author: "wren" },
        { id: 22, state: "APPROVED", body: "", author: "kit" },
      ],
      checks: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "failure" },
      ],
    });
  }, 180_000);

  test("the page: the list, and one of them with its comments and its checks", async () => {
    const list = (await call(
      `/api/workspaces/${ws}/projects/${project}/pull-requests?connection_id=${connection}`,
    )) as { status: number; text: string; body: { pull_requests: { number: number }[] } };
    expect(list.status, list.text).toBe(200);
    expect(list.body.pull_requests.map((one) => one.number)).toEqual([7]);

    const one = (await call(
      `/api/workspaces/${ws}/projects/${project}/pull-requests/7?connection_id=${connection}`,
    )) as {
      status: number;
      text: string;
      body: {
        title: string;
        head: { branch: string };
        comments: { path: string; line: number; body: string; diff_hunk: string | null }[];
        reviews: { state: string }[];
        checks: { name: string; conclusion: string | null }[];
      };
    };
    expect(one.status, one.text).toBe(200);
    expect(one.body.title).toBe("An answer");
    expect(one.body.head.branch).toBe(BRANCH);
    // Inline: the file and the line, which is the whole difference between a review and a chat.
    expect(one.body.comments).toHaveLength(1);
    expect(one.body.comments[0]).toMatchObject({ path: "answer.txt", line: 1 });
    expect(one.body.comments[0]?.diff_hunk).toContain("@@");
    expect(one.body.reviews.map((r) => r.state).sort()).toEqual(["APPROVED", "CHANGES_REQUESTED"]);
    // And what the checks made of it, which is the other half of a reviewer's decision.
    expect(one.body.checks.find((c) => c.name === "test")?.conclusion).toBe("failure");

    // The token that fetched all of that is in none of it.
    expect(one.text).not.toContain("ghs_minted");
  }, 120_000);

  test("request changes says why, or it is not a request", async () => {
    const empty = await call(`/api/workspaces/${ws}/projects/${project}/pull-requests/7/reviews`, {
      method: "POST",
      json: { connection_id: connection, verdict: "request_changes" },
    });
    expect(empty.status).toBe(422);

    const said = await call(`/api/workspaces/${ws}/projects/${project}/pull-requests/7/reviews`, {
      method: "POST",
      json: {
        connection_id: connection,
        verdict: "request_changes",
        body: "One more thing.",
      },
    });
    expect(said.status, said.text).toBe(201);
    expect(github.reviews.at(-1)).toMatchObject({
      number: 7,
      event: "REQUEST_CHANGES",
      body: "One more thing.",
    });
  }, 120_000);

  test("the acceptance: a review comment becomes a turn, and the push answers it", async () => {
    const asked = (await call(`/api/workspaces/${ws}/projects/${project}/pull-requests/7/address`, {
      method: "POST",
      json: { connection_id: connection, engine: "fixer" },
    })) as {
      status: number;
      text: string;
      body: { session_id: string; comments: number; branch: string };
    };
    expect(asked.status, asked.text).toBe(201);
    expect(asked.body.comments).toBe(1);
    expect(asked.body.branch).toBe(BRANCH);

    // The turn it was given is the review: the file, the line, and what was said on it.
    const events = (await call(`/api/sessions/${asked.body.session_id}/events`)) as {
      body: { events: { event: { type: string; text?: string } }[] };
    };
    const turn = events.body.events.find((one) => one.event.type === "turn")?.event.text ?? "";
    expect(turn).toContain("answer.txt:1");
    expect(turn).toContain("this should be 42");
    expect(turn).toContain("wren");
    // The review body rides along; the approval does not, because it asked for nothing.
    expect(turn).toContain("Nearly.");

    // It worked on the pull request's own branch, in a worktree of its own.
    await until(() => readFileSync(join(worktree(BRANCH), "answer.txt"), "utf8").trim() === "42");

    // The push is the answer: what it wrote, committed on the branch and sent to the remote.
    git(worktree(BRANCH), "commit", "-am", "42");
    const pushed = await call(`/api/workspaces/${ws}/projects/${project}/git/push`, {
      method: "POST",
      json: { branch: BRANCH, connection_id: connection },
    });
    expect(pushed.status, pushed.text).toBe(200);

    // And the remote really has it, on the branch the pull request is for.
    const onTheRemote = execFileSync("git", ["show", `${BRANCH}:answer.txt`], {
      cwd: github.bare,
      encoding: "utf8",
    });
    expect(onTheRemote.trim()).toBe("42");
  }, 300_000);

  test("a pull request whose branch is not here is refused, not faked", async () => {
    github.pulls.set(9, {
      number: 9,
      title: "From somewhere else",
      branch: "someone-elses/branch",
      sha: "0".repeat(40),
      comments: [{ id: 31, path: "README.md", line: 1, body: "please", author: "wren" }],
    });
    const refused = (await call(
      `/api/workspaces/${ws}/projects/${project}/pull-requests/9/address`,
      { method: "POST", json: { connection_id: connection } },
    )) as { status: number; text: string };
    expect(refused.status).toBe(422);
    expect(refused.text).toContain("someone-elses/branch");
  }, 120_000);
});
