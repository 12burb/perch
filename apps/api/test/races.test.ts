import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEngine } from "@perch/engines";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { claimDecision, getRace, insertRace } from "../src/repos/races.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.16 (spec §5.7 "same task on two engines/models side by side; compare diffs, cost,
 * preflight; pick a winner"): the acceptance is that a race finishes with one diff applied and the
 * rest discarded.
 *
 * Two engines, one question, two worktrees. Each writes a real file into its own checkout and each
 * is measured the way a person would measure it — how much it changed, what it cost, what the
 * project's checks made of it — and then the winner's branch lands while the loser's directory
 * goes back.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let cookie = "";
let ws = "";
let project = "";

/**
 * Both engines do the same job and neither is told what the other did. `quick` writes a small
 * correct change; `sprawl` writes a big one that fails the project's checks — which is the case
 * that makes "decided by the checks" mean something.
 *
 * Each one writes into the checkout it was given, the way a real engine would, so what the race
 * measures is a real diff in a real worktree rather than a number the test made up. The
 * directories they write to are kept, because two entrants writing to two different places is the
 * isolation a race depends on.
 */
const wroteIn: string[] = [];

function engine(id: string, lines: number, costUsd: number) {
  return new FakeEngine({
    id,
    script: (_turn, context) => {
      const dir = worktree(context.params.worktree ?? "");
      wroteIn.push(dir);
      writeFileSync(join(dir, "header.txt"), "a line\n".repeat(lines));
      git(dir, "add", ".");
      git(dir, "commit", "-m", `${id}: a header`);
      return [
        {
          type: "tool_result",
          id: "w",
          output: "wrote header.txt",
          diff: [
            {
              path: "header.txt",
              patch: `${"+a line\n".repeat(lines)}`,
              additions: lines,
              deletions: 0,
              status: "added",
            },
          ],
        },
        { type: "usage", input: 10, output: 5, costUsd },
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
      engines: [engine("quick", 2, 0.1), engine("sprawl", 40, 0.9)],
      sessions: { silenceMs: 60_000 },
    },
  );
  projectsDir = mkdtempSync(join(tmpdir(), "perch-race-"));
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

type Entrant = {
  id: string;
  engine: string;
  branch: string;
  state: string;
  cost_usd: number | null;
  additions: number | null;
  checks_exit_code: number | null;
};
type Race = {
  id: string;
  state: string;
  decided_by: string | null;
  winner_id: string | null;
  entrants: Entrant[];
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

let raceId = "";

describe("race mode (task 3.16)", () => {
  test("a project with checks, and two engines to ask", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-race-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Race" } })) as {
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

    // The project's checks: header.txt must be short. A sprawling answer fails them, which is what
    // lets the checks decide without anybody looking.
    writeFileSync(
      join(checkout(), "check.sh"),
      '#!/bin/sh\n[ -f header.txt ] || exit 0\nlines=$(wc -l < header.txt)\n[ "$lines" -le 10 ] || { echo "header.txt is $lines lines, which is too many"; exit 1; }\n',
    );
    mkdirSync(join(checkout(), ".perch"), { recursive: true });
    writeFileSync(
      join(checkout(), ".perch", "project.json"),
      JSON.stringify({ run: { check: "sh check.sh" } }, null, 2),
    );
    writeFileSync(join(checkout(), "README.md"), "# the site\n");
    git(checkout(), "add", "-A");
    git(checkout(), "commit", "-m", "first");
    expect(
      (await call(`/api/workspaces/${ws}/projects/${project}/config/reload`, { method: "POST" }))
        .status,
    ).toBe(200);
  }, 180_000);

  test("a race is decided once: the second claim finds it decided already (ADR-0165)", async () => {
    const race = await insertRace(booted.db.db, {
      workspaceId: ws,
      projectId: project,
      prompt: "which is quicker",
    });
    const claims = await Promise.all(
      ["checks", "checks"].map((by) =>
        claimDecision(booted.db.db, race.id, { decidedBy: by as "checks" }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await getRace(booted.db.db, race.id))?.state).toBe("decided");
    expect(await claimDecision(booted.db.db, race.id, { decidedBy: "checks" })).toBeNull();
  });

  test("the acceptance: a race finishes with one diff applied and the rest discarded", async () => {
    const started = (await call(`/api/workspaces/${ws}/projects/${project}/races`, {
      method: "POST",
      json: {
        prompt: "add a header",
        runners: [{ engine: "quick" }, { engine: "sprawl" }],
      },
    })) as { status: number; text: string; body: Race };
    expect(started.status, started.text).toBe(201);
    raceId = started.body.id;
    expect(started.body.entrants.map((one) => one.engine).sort()).toEqual(["quick", "sprawl"]);

    // A branch per engine, and neither is the project checkout: two agents on one repository are
    // only safe because they are looking at two different directories (task 3.14).
    const branches = started.body.entrants.map((one) => one.branch);
    expect(new Set(branches).size).toBe(2);
    expect(new Set(wroteIn).size).toBe(2);
    expect(wroteIn).not.toContain(checkout());

    // Both sessions settle on their own — nobody is at a keyboard for an entrant — and the race
    // measures what each one did as they do.
    await until(async () => {
      const now = (await call(`/api/races/${raceId}`)) as { body: Race };
      return now.body.entrants.every((one) => one.state !== "running");
    }, 120_000);
    await booted.mergeQueue.settled(120_000);

    const decided = ((await call(`/api/races/${raceId}`)) as { body: Race }).body;
    // Nobody looked: the checks decided, because only one answer passes them.
    expect(decided.state).toBe("decided");
    expect(decided.decided_by).toBe("checks");

    const byEngine = new Map(decided.entrants.map((one) => [one.engine, one]));
    expect(byEngine.get("quick")?.state).toBe("won");
    expect(byEngine.get("sprawl")?.state).toBe("discarded");
    expect(decided.winner_id).toBe(byEngine.get("quick")?.id ?? "");

    // The comparison a person would have made is on the record: the diff, the cost, the checks.
    expect(byEngine.get("quick")?.additions).toBe(2);
    expect(byEngine.get("sprawl")?.additions).toBe(40);
    expect(byEngine.get("quick")?.checks_exit_code).toBe(0);
    expect(byEngine.get("sprawl")?.checks_exit_code).not.toBe(0);
    expect(byEngine.get("quick")?.cost_usd).toBeCloseTo(0.1, 2);

    // One diff applied: the winner landed on main through the queue.
    git(checkout(), "checkout", "main");
    expect(git(checkout(), "ls-tree", "--name-only", "HEAD")).toContain("header.txt");
    expect(git(checkout(), "show", "HEAD:header.txt").trim().split("\n")).toHaveLength(2);

    // The rest discarded: the loser's directory is gone, and its branch is still there to look at.
    const loser = byEngine.get("sprawl")?.branch ?? "";
    await until(() => !existsSync(worktree(loser)));
    expect(git(checkout(), "branch", "--list", loser)).toContain(loser);
  }, 300_000);

  test("a race of one is a session, and a decided race is decided", async () => {
    const tooFew = await call(`/api/workspaces/${ws}/projects/${project}/races`, {
      method: "POST",
      json: { prompt: "alone", runners: [{ engine: "quick" }] },
    });
    expect(tooFew.status).toBe(422);

    // Two of the same engine would be two entrants on one branch, which is not a race.
    const twice = await call(`/api/workspaces/${ws}/projects/${project}/races`, {
      method: "POST",
      json: { prompt: "again", runners: [{ engine: "quick" }, { engine: "quick" }] },
    });
    expect(twice.status).toBe(422);
    expect(twice.text).toContain("only enter a race once");

    const entrants = ((await call(`/api/races/${raceId}`)) as { body: Race }).body.entrants;
    const loser = entrants.find((one) => one.state === "discarded");
    const again = await call(`/api/races/${raceId}/pick/${loser?.id ?? ""}`, { method: "POST" });
    expect(again.status).toBe(409);
  }, 120_000);
});
