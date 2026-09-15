import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { onlyPaths } from "../src/routes/git.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.20 (spec §5.1 "git panel: status, stage, AI commit message, branch, push, Open PR"): the
 * routes the panel is made of, against a real git repository on the in-process runner and the fake
 * ACP agent for the message.
 *
 * Pushing and opening a pull request are the same credential path as a clone's and are covered end
 * to end in connections.test.ts against a stand-in GitHub; what is new here is everything that
 * happens before the branch leaves the machine.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let ws = "";
let project = "";
let cookie = "";
const fixture = join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "acp-agent.ts");

beforeAll(async () => {
  booted = await bootTestApp({}, { sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-git-"));
  booted.runners.attach(
    createInProcessRunner({
      projectsDir,
      portsIntervalMs: 0,
      sessions: {
        agents: { fake: { name: "Fake Agent", command: process.execPath, args: [fixture] } },
        defaultAgent: "fake",
      },
    }),
  );
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  rmSync(projectsDir, { recursive: true, force: true });
});

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  return { status: res.status, body: (res.status === 204 ? null : await res.json()) as unknown };
}

type Status = {
  branch: string | null;
  clean: boolean;
  files: { path: string; index: string; working_tree: string }[];
};

describe("the git panel's routes (task 1.20)", () => {
  test("status, a drafted message, a commit, and a branch", async () => {
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Wren",
        email: `wren-git-${Date.now()}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    const created = (await call("/api/workspaces", {
      method: "POST",
      json: { name: "Git Nest" },
    })) as { body: { id: string } };
    ws = created.body.id;

    const madeProject = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "Repo" },
    })) as { body: { id: string } };
    project = madeProject.body.id;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = (await call(`/api/workspaces/${ws}/projects/${project}`)) as {
        body: { status: string; status_message: string | null };
      };
      if (res.body.status === "ready") break;
      if (res.body.status === "error" || Date.now() > deadline) {
        throw new Error(`project ${res.body.status}: ${res.body.status_message}`);
      }
      await Bun.sleep(50);
    }

    // A fresh project is a git repository with nothing to say.
    const clean = (await call(`/api/workspaces/${ws}/projects/${project}/git/status`)) as {
      body: Status;
    };
    expect(clean.body.clean).toBe(true);
    expect(clean.body.files).toEqual([]);

    // Write a file the way the editor does, and it shows up as a change.
    const wrote = await call(`/api/workspaces/${ws}/projects/${project}/fs/write`, {
      method: "PUT",
      json: { path: "notes.md", content: "# Notes\n\nthe first line\n" },
    });
    expect(wrote.status).toBe(200);
    const dirty = (await call(`/api/workspaces/${ws}/projects/${project}/git/status`)) as {
      body: Status;
    };
    expect(dirty.body.clean).toBe(false);
    expect(dirty.body.files.map((f) => f.path)).toContain("notes.md");

    // "Write it for me": the fake agent answers on the project's inline lane.
    const drafted = (await call(`/api/workspaces/${ws}/projects/${project}/git/message`, {
      method: "POST",
      json: {},
    })) as { status: number; body: { message: string; session_id: string } };
    expect(drafted.status).toBe(200);
    expect(drafted.body.message).toMatch(/^feat\(notes\): update notes\.md/);
    // The message comes back as a message: no fences, no preamble.
    expect(drafted.body.message).not.toContain("```");

    // Commit it, as the member rather than the runner's git config.
    const committed = (await call(`/api/workspaces/${ws}/projects/${project}/git/commit`, {
      method: "POST",
      json: { message: drafted.body.message, paths: ["notes.md"] },
    })) as { status: number; body: { commit: string; branch: string } };
    expect(committed.status).toBe(201);
    expect(committed.body.commit).toMatch(/^[0-9a-f]{7,40}$/);

    const after = (await call(`/api/workspaces/${ws}/projects/${project}/git/status`)) as {
      body: Status;
    };
    expect(after.body.clean).toBe(true);

    // Now there is a HEAD, so the diff route shows a later change against it.
    const again = await call(`/api/workspaces/${ws}/projects/${project}/fs/write`, {
      method: "PUT",
      json: { path: "notes.md", content: "# Notes\n\nthe second line\n" },
    });
    expect(again.status).toBe(200);
    const diff = (await call(`/api/workspaces/${ws}/projects/${project}/git/diff?ref=HEAD`)) as {
      body: { diff: string; files: { path: string }[] };
    };
    expect(diff.body.diff).toContain("the second line");
    expect(diff.body.files.map((f) => f.path)).toContain("notes.md");
    const second = (await call(`/api/workspaces/${ws}/projects/${project}/git/commit`, {
      method: "POST",
      json: { message: "chore: second line" },
    })) as { status: number };
    expect(second.status).toBe(201);

    // Nothing to describe is a conflict, not an empty message.
    const nothing = await call(`/api/workspaces/${ws}/projects/${project}/git/message`, {
      method: "POST",
      json: {},
    });
    expect(nothing.status).toBe(409);

    // Branches: the one it is on, and a new one to switch to.
    const branches = (await call(`/api/workspaces/${ws}/projects/${project}/git/branches`)) as {
      body: { current: string | null; branches: string[] };
    };
    expect(branches.body.current).toBe(committed.body.branch);
    const switched = (await call(`/api/workspaces/${ws}/projects/${project}/git/branches`, {
      method: "POST",
      json: { name: "perch/notes", create: true },
    })) as { status: number; body: { current: string | null; created?: boolean } };
    expect(switched.status).toBe(200);
    expect(switched.body.current).toBe("perch/notes");
    const onBranch = (await call(`/api/workspaces/${ws}/projects/${project}/git/status`)) as {
      body: Status;
    };
    expect(onBranch.body.branch).toBe("perch/notes");

    // A push with no remote fails as a git failure, not a hang or a 500.
    const pushed = await call(`/api/workspaces/${ws}/projects/${project}/git/push`, {
      method: "POST",
      json: {},
    });
    expect([409, 502]).toContain(pushed.status);
  }, 120_000);

  test("a planted key stops the commit, and taking it out lets it through (task 2.12)", async () => {
    const planted = `AKIA${"IOSFODNN7QQWERTY"}`;
    const wrote = await call(`/api/workspaces/${ws}/projects/${project}/fs/write`, {
      method: "PUT",
      json: { path: "config.ts", content: `export const key = "${planted}";\n` },
    });
    expect(wrote.status).toBe(200);

    const blocked = (await call(`/api/workspaces/${ws}/projects/${project}/git/commit`, {
      method: "POST",
      json: { message: "feat: add config" },
    })) as {
      status: number;
      body: {
        error: {
          code: string;
          message: string;
          details?: { rule?: string; findings?: { path: string; sample: string }[] };
        };
      };
    };
    // 451: the policy engine's own status (spec §7.8).
    expect(blocked.status).toBe(451);
    expect(blocked.body.error.code).toBe("policy_violation");
    expect(blocked.body.error.details?.rule).toBe("secrets.scan");
    expect(blocked.body.error.details?.findings?.[0]?.path).toBe("config.ts");
    // What the card shows is enough to find it and not enough to use it.
    expect(JSON.stringify(blocked.body)).not.toContain(planted);

    // Nothing was committed: the change is still sitting there.
    const still = (await call(`/api/workspaces/${ws}/projects/${project}/git/status`)) as {
      body: Status;
    };
    expect(still.body.files.map((f) => f.path)).toContain("config.ts");

    // Taking it out lets the same commit through.
    await call(`/api/workspaces/${ws}/projects/${project}/fs/write`, {
      method: "PUT",
      json: { path: "config.ts", content: 'export const key = process.env.AWS_KEY ?? "";\n' },
    });
    const through = (await call(`/api/workspaces/${ws}/projects/${project}/git/commit`, {
      method: "POST",
      json: { message: "feat: add config" },
    })) as { status: number };
    expect(through.status).toBe(201);
  }, 120_000);

  test("only the chosen files are described", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-one",
      "+ONE",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-two",
      "+TWO",
      "",
    ].join("\n");
    const files = [{ path: "a.ts" }, { path: "b.ts" }];
    const only = onlyPaths(diff, files, new Set(["b.ts"]));
    expect(only).toContain("b/b.ts");
    expect(only).not.toContain("b/a.ts");
    // Everything selected is the diff itself, untouched.
    expect(onlyPaths(diff, files, new Set(["a.ts", "b.ts"]))).toBe(diff);
  });
});
