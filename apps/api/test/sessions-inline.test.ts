import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { inlineEditPrompt } from "../src/services/sessions.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.14 (spec §4 ⌘K inline edit): the api rewrites a selection on the project's inline
 * session. The reply is the replacement and nothing else; the session is reused across edits and
 * stays out of the session list; a permission asked mid-round is refused and the round goes on.
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

type EditBody = { replacement: string; session_id: string };

beforeAll(async () => {
  booted = await bootTestApp({}, { sessions: { silenceMs: 60_000, inlineMs: 30_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-inline-api-"));
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

describe("inline edits (task 1.14)", () => {
  test("the prompt asks for the replacement alone, and names the file and the selection", () => {
    const prompt = inlineEditPrompt({
      path: "src/a.ts",
      selection: "const a = 1;",
      instruction: "make it a let",
      language: "ts",
    });
    expect(prompt.startsWith("Perch inline edit.")).toBe(true);
    expect(prompt).toContain("File: src/a.ts");
    expect(prompt).toContain("Instruction: make it a let");
    expect(prompt).toContain("```ts\nconst a = 1;\n```");
    expect(prompt).toContain("Do not edit any file yourself");
    // Without a language the fence is still a fence.
    expect(inlineEditPrompt({ path: "a.txt", selection: "x", instruction: "y" })).toContain(
      "```\nx\n```",
    );
  });

  test("a selection comes back rewritten, on one reused session that the list hides", async () => {
    const owner = await signUp("Ivy", "ivy-inline@perch.test");
    const stranger = await signUp("Sam", "sam-inline@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Inline Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;
    const project = await readyProject(owner.cookie, ws, "Edits");
    const path = `/api/workspaces/${ws}/projects/${project}/inline-edit`;

    const first = (await call(path, owner.cookie, {
      method: "POST",
      json: { path: "notes.txt", selection: "one\ntwo", instruction: "uppercase it" },
    })) as { status: number; body: EditBody };
    expect(first.status).toBe(200);
    expect(first.body.replacement).toBe("ONE\nTWO");

    // The same lane answers the next edit, and no file was touched.
    const second = (await call(path, owner.cookie, {
      method: "POST",
      json: {
        path: "notes.txt",
        selection: "three",
        instruction: "comment it out",
        language: "txt",
      },
    })) as { status: number; body: EditBody };
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      replacement: "// three",
      session_id: first.body.session_id,
    });

    // A permission asked mid-round is refused, and the agent still answers.
    const asked = (await call(path, owner.cookie, {
      method: "POST",
      json: { path: "notes.txt", selection: "four", instruction: "ask permission, uppercase it" },
    })) as { status: number; body: EditBody };
    expect(asked.status).toBe(200);
    expect(asked.body.replacement).toBe("FOUR");
    const replay = (await call(`/api/sessions/${first.body.session_id}/events`, owner.cookie)) as {
      body: { events: { event: { type: string; delta?: string } }[] };
    };
    expect(replay.body.events.some((e) => e.event.type === "permission")).toBe(true);
    // The agent says which answer it got, so this tells a denial from an approval: the api must
    // refuse, because nobody is watching an inline round (ADR-0080 §4).
    const said = replay.body.events
      .map((e) => e.event)
      .filter((event): event is { type: "text"; delta: string } => event.type === "text")
      .map((event) => event.delta)
      .join("");
    expect(said).toContain("Denied, answering anyway.");
    expect(said).not.toContain("Allowed.");
    expect(replay.body.events.at(-1)?.event.type).toBe("done");

    // The inline lane is not a session anyone browses.
    const listed = (await call(
      `/api/workspaces/${ws}/projects/${project}/sessions`,
      owner.cookie,
    )) as { body: { sessions: { id: string }[] } };
    expect(listed.body.sessions.map((s) => s.id)).not.toContain(first.body.session_id);

    // It is still a session of the owner's: a stranger reaches neither it nor the route.
    expect((await call(`/api/sessions/${first.body.session_id}`, stranger.cookie)).status).toBe(
      404,
    );
    expect(
      (
        await call(path, stranger.cookie, {
          method: "POST",
          json: { path: "notes.txt", selection: "five", instruction: "uppercase it" },
        })
      ).status,
    ).toBe(404);
    // An empty instruction is a 422, not a turn.
    expect(
      (
        await call(path, owner.cookie, {
          method: "POST",
          json: { path: "notes.txt", selection: "six", instruction: "" },
        })
      ).status,
    ).toBe(422);
  }, 60_000);
});
