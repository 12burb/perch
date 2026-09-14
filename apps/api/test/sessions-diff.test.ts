import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileDiff, SessionEvent } from "@perch/events";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.13 through the REST routes: every turn takes a checkpoint first; the diff of a turn is
 * its checkpoint to the next; rejecting a hunk takes it back out of the file; restoring turn 1
 * puts the project back to before the session touched it and the transcript says so.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
const fixture = join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "acp-agent.ts");

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function signUp(name: string, email: string) {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  return { cookie: cookiesFrom(res) };
}

async function call(path: string, cookie: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  return { status: res.status, body: (res.status === 204 ? null : await res.json()) as unknown };
}

type SessionBody = {
  id: string;
  status: string;
  status_message: string | null;
  turns: number;
  forked_from_id: string | null;
};
type DiffBody = {
  turn: number | null;
  from_turn: number;
  to_turn: number | null;
  files: FileDiff[];
};
type CheckpointsBody = { checkpoints: { turn: number; git_ref: string; created_at: string }[] };

async function readyProject(cookie: string, ws: string, name: string): Promise<string> {
  const created = (await call(`/api/workspaces/${ws}/projects`, cookie, {
    method: "POST",
    json: { name },
  })) as { body: { id: string } };
  const id = created.body.id;
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = (await call(`/api/workspaces/${ws}/projects/${id}`, cookie)) as {
      body: { status: string; status_message: string | null };
    };
    if (res.body.status === "ready") return id;
    if (res.body.status === "error" || Date.now() > deadline) {
      throw new Error(`project ${res.body.status}: ${res.body.status_message}`);
    }
    await Bun.sleep(50);
  }
}

async function untilStatus(cookie: string, id: string, status: string): Promise<SessionBody> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = (await call(`/api/sessions/${id}`, cookie)) as { body: SessionBody };
    if (res.body.status === status) return res.body;
    if (Date.now() > deadline) {
      throw new Error(`session stayed ${res.body.status} (${res.body.status_message})`);
    }
    await Bun.sleep(25);
  }
}

async function turn(cookie: string, id: string, text: string): Promise<SessionBody> {
  const sent = await call(`/api/sessions/${id}/turns`, cookie, { method: "POST", json: { text } });
  expect(sent.status).toBe(202);
  return untilStatus(cookie, id, "idle");
}

const hunks = (file: FileDiff | undefined) => file?.patch.match(/^@@ .*$/gm) ?? [];

beforeAll(async () => {
  booted = await bootTestApp({}, { sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-diff-api-"));
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

describe("diffs, hunk decisions, and checkpoints (task 1.13)", () => {
  test("checkpoint per turn → diff of turn 2 → reject one hunk → restore turn 1", async () => {
    const owner = await signUp("Dee", "dee-diff@perch.test");
    const stranger = await signUp("Sol", "sol-diff@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Diff Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;
    const project = await readyProject(owner.cookie, ws, "Review");
    const notes = join(projectsDir, ws, project, "notes.txt");

    const opened = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, owner.cookie, {
      method: "POST",
      json: { engine: "acp", model: { provider: "fake", model_id: "default" }, prompt: "seed" },
    })) as { status: number; body: SessionBody };
    expect(opened.status).toBe(201);
    const id = opened.body.id;
    await untilStatus(owner.cookie, id, "idle");
    expect(existsSync(notes)).toBe(true);
    await turn(owner.cookie, id, "spread");
    expect(readFileSync(notes, "utf8")).toContain("line 28 (edited)");

    // One checkpoint before each turn.
    const checkpoints = (await call(`/api/sessions/${id}/checkpoints`, owner.cookie)) as {
      body: CheckpointsBody;
    };
    expect(checkpoints.body.checkpoints.map((c) => c.turn)).toEqual([1, 2]);
    expect(checkpoints.body.checkpoints[0]?.git_ref).toMatch(/^[0-9a-f]{40}$/);

    // Turn 2's diff: three hunks in notes.txt; the whole session: notes.txt added.
    const second = (await call(`/api/sessions/${id}/diff?turn=2`, owner.cookie)) as {
      status: number;
      body: DiffBody;
    };
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ turn: 2, from_turn: 2, to_turn: null });
    expect(second.body.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["notes.txt", "modified", 3, 3],
    ]);
    const before = hunks(second.body.files[0]);
    expect(before).toHaveLength(3);
    const whole = (await call(`/api/sessions/${id}/diff`, owner.cookie)) as { body: DiffBody };
    expect(whole.body).toMatchObject({ turn: null, from_turn: 1, to_turn: null });
    expect(whole.body.files.map((f) => [f.path, f.status, f.additions])).toEqual([
      ["notes.txt", "added", 30],
    ]);
    const first = (await call(`/api/sessions/${id}/diff?turn=1`, owner.cookie)) as {
      body: DiffBody;
    };
    expect(first.body).toMatchObject({ turn: 1, from_turn: 1, to_turn: 2 });
    expect(first.body.files[0]?.status).toBe("added");

    // Accept two hunks, reject the third: line 28 goes back, the others stay.
    const applied = (await call(`/api/sessions/${id}/diff/apply`, owner.cookie, {
      method: "POST",
      json: {
        turn: 2,
        decisions: [
          { path: "notes.txt", hunk: 0, header: before[0], action: "accept" },
          { path: "notes.txt", hunk: 1, header: before[1], action: "accept" },
          { path: "notes.txt", hunk: 2, header: before[2], action: "reject" },
        ],
      },
    })) as { status: number; body: { files: string[] } };
    expect(applied.status).toBe(200);
    expect(applied.body).toEqual({ files: ["notes.txt"] });
    const text = readFileSync(notes, "utf8");
    expect(text).toContain("line 2 (edited)");
    expect(text).toContain("line 15 (edited)");
    expect(text).toContain("\nline 28\n");
    const after = (await call(`/api/sessions/${id}/diff?turn=2`, owner.cookie)) as {
      body: DiffBody;
    };
    expect(hunks(after.body.files[0])).toHaveLength(2);

    // A stale header is a conflict; a stranger sees nothing.
    const stale = await call(`/api/sessions/${id}/diff/apply`, owner.cookie, {
      method: "POST",
      json: {
        turn: 2,
        decisions: [{ path: "notes.txt", hunk: 2, header: before[2], action: "reject" }],
      },
    });
    expect(stale.status).toBe(409);
    expect((await call(`/api/sessions/${id}/diff`, stranger.cookie)).status).toBe(404);
    expect(
      (await call(`/api/sessions/${id}/checkpoints/1/restore`, stranger.cookie, { method: "POST" }))
        .status,
    ).toBe(404);

    // Restore turn 1: the project is as it was before the session; the transcript says so.
    const restored = (await call(`/api/sessions/${id}/checkpoints/1/restore`, owner.cookie, {
      method: "POST",
    })) as { status: number; body: { turn: number; git_ref: string; files: string[] } };
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ turn: 1, files: ["notes.txt"] });
    expect(existsSync(notes)).toBe(false);
    const empty = (await call(`/api/sessions/${id}/diff`, owner.cookie)) as { body: DiffBody };
    expect(empty.body.files).toEqual([]);
    const replay = (await call(`/api/sessions/${id}/events`, owner.cookie)) as {
      body: { events: { event: SessionEvent }[] };
    };
    expect(replay.body.events.at(-1)?.event).toMatchObject({ type: "restore", turn: 1 });
    expect(
      (await call(`/api/sessions/${id}/checkpoints/9/restore`, owner.cookie, { method: "POST" }))
        .status,
    ).toBe(404);
    expect((await call(`/api/sessions/${id}/diff?turn=9`, owner.cookie)).status).toBe(404);
  }, 60_000);

  test("a fork inherits the turn count and the checkpoints, so it can restore them", async () => {
    const owner = await signUp("Fay", "fay-diff@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Fork Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;
    const project = await readyProject(owner.cookie, ws, "Forked");
    const notes = join(projectsDir, ws, project, "notes.txt");

    const opened = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, owner.cookie, {
      method: "POST",
      json: { engine: "acp", model: { provider: "fake", model_id: "default" }, prompt: "seed" },
    })) as { body: SessionBody };
    const id = opened.body.id;
    await untilStatus(owner.cookie, id, "idle");
    await turn(owner.cookie, id, "spread");

    const forked = (await call(`/api/sessions/${id}/fork`, owner.cookie, { method: "POST" })) as {
      status: number;
      body: SessionBody;
    };
    expect(forked.status).toBe(201);
    const fork = forked.body.id;
    // The transcript came along, so the turn count and the checkpoints must line up with it.
    expect(forked.body).toMatchObject({ forked_from_id: id, turns: 2 });
    const carried = (await call(`/api/sessions/${fork}/checkpoints`, owner.cookie)) as {
      body: CheckpointsBody;
    };
    const original = (await call(`/api/sessions/${id}/checkpoints`, owner.cookie)) as {
      body: CheckpointsBody;
    };
    expect(carried.body.checkpoints.map((c) => [c.turn, c.git_ref])).toEqual(
      original.body.checkpoints.map((c) => [c.turn, c.git_ref]),
    );

    // The fork's checkpoints were taken under the session it copied, and it restores them anyway.
    expect(readFileSync(notes, "utf8")).toContain("line 28 (edited)");
    const restored = (await call(`/api/sessions/${fork}/checkpoints/1/restore`, owner.cookie, {
      method: "POST",
    })) as { status: number; body: { turn: number; files: string[] } };
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ turn: 1, files: ["notes.txt"] });
    expect(existsSync(notes)).toBe(false);
    const empty = (await call(`/api/sessions/${fork}/diff`, owner.cookie)) as { body: DiffBody };
    expect(empty.body.files).toEqual([]);

    // The next turn on the fork is turn 3, not turn 1 again.
    await turn(owner.cookie, fork, "seed");
    const after = (await call(`/api/sessions/${fork}/checkpoints`, owner.cookie)) as {
      body: CheckpointsBody;
    };
    expect(after.body.checkpoints.map((c) => c.turn)).toEqual([1, 2, 3]);
  }, 60_000);
});
