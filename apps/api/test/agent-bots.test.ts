import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";
import { type StandInGitHub, startStandInGitHub } from "./fixtures/github.ts";

/**
 * Task 3.7 (spec §5.3 "Agent bots: `engine: opencode|acp` + `projects: [...]` — `@dawn add a
 * dark-mode toggle` opens a session on that project, posts a session_card in the thread, asks
 * permissions in-thread, and finishes with a diff_card, Open in IDE, and a PR link"), which is the
 * first half of §10's Phase 3 exit criterion.
 *
 * It runs against the things themselves: a stand-in GitHub serving git's smart HTTP so the clone,
 * the push and the pull request all really happen, and the fake ACP agent, which asks for a
 * permission before it edits. Nothing between the mention and the pull request is stubbed.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let github: StandInGitHub;
const TOKEN = "ghp_agentbots0000000000000000000000";
const fixture = join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "acp-agent.ts");

beforeAll(async () => {
  github = await startStandInGitHub({ token: TOKEN });
  booted = await bootTestApp({}, { sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-agent-bots-"));
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
}, 90_000);

afterAll(async () => {
  await running.stop();
  github?.stop();
  rmSync(projectsDir, { recursive: true, force: true });
});

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, cookie: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

async function signUp(name: string, email: string) {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  const cookie = cookiesFrom(res);
  const me = (await call("/api/me", cookie)) as { body: { id: string } };
  return { cookie, id: me.body.id };
}

type Block = {
  type: string;
  id?: string;
  text?: string;
  summary?: string;
  url?: string;
  prUrl?: string;
  prNumber?: number;
  sessionId?: string;
};
type MessageBody = { id: string; author_type: string; blocks: Block[] };

let ws = "";
let channel = "";
let projectId = "";
let botId = "";
let connectionId = "";
let owner = { cookie: "", id: "" };

const thread = async (rootId: string): Promise<MessageBody[]> => {
  const res = (await call(`/api/workspaces/${ws}/messages/${rootId}/thread`, owner.cookie)) as {
    body: { messages: MessageBody[] };
  };
  return res.body.messages;
};

/** Waits for a block of this type to turn up in the thread, and hands it back. */
async function waitForBlock(rootId: string, type: string, ms = 60_000): Promise<Block> {
  const deadline = Date.now() + ms;
  for (;;) {
    for (const message of await thread(rootId)) {
      const block = message.blocks.find((one) => one.type === type);
      if (block) return block;
    }
    if (Date.now() > deadline) throw new Error(`no ${type} in the thread after ${ms}ms`);
    await Bun.sleep(100);
  }
}

describe("agent bots (task 3.7)", () => {
  test("a bot with an engine and a project is installed in a channel", async () => {
    const stamp = Date.now();
    owner = await signUp("Robin", `robin-agent-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Agent Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const room = (await call(`/api/workspaces/${ws}/channels`, owner.cookie, {
      method: "POST",
      json: { type: "public", name: "build" },
    })) as { body: { id: string } };
    channel = room.body.id;

    // The connection the clone, the push and the pull request all run on.
    const connection = (await call(`/api/workspaces/${ws}/connections`, owner.cookie, {
      method: "POST",
      json: {
        kind: "token",
        provider: "github",
        owner_type: "workspace",
        token: TOKEN,
        api_base: github.url,
      },
    })) as { status: number; text: string; body: { id: string } };
    expect(connection.status, connection.text).toBe(201);
    connectionId = connection.body.id;

    const project = (await call(`/api/workspaces/${ws}/projects/clone`, owner.cookie, {
      method: "POST",
      json: {
        name: "Aviary",
        repo_url: github.repoUrl,
        auth: { kind: "connection", connection_id: connectionId },
      },
    })) as { status: number; text: string; body: { id: string } };
    expect(project.status, project.text).toBe(201);
    projectId = project.body.id;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const res = (await call(`/api/workspaces/${ws}/projects/${projectId}`, owner.cookie)) as {
        body: { status: string; status_message: string | null };
      };
      if (res.body.status === "ready") break;
      if (res.body.status === "error" || Date.now() > deadline) {
        throw new Error(`clone ${res.body.status}: ${res.body.status_message}`);
      }
      await Bun.sleep(50);
    }

    // An agent bot: no brain, an engine and a project. A mention is a session, not an answer.
    const bot = (await call(`/api/workspaces/${ws}/bots`, owner.cookie, {
      method: "POST",
      json: {
        handle: "dawn",
        name: "Dawn",
        visibility: "workspace",
        spec: {
          persona: "You do the work.",
          engine: "acp",
          projects: ["Aviary"],
          connection: connectionId,
          triggers: [{ on: "mention" }],
        },
        budget: { dailyUsd: 5 },
      },
    })) as { status: number; text: string; body: { id: string } };
    expect(bot.status, bot.text).toBe(201);
    botId = bot.body.id;
    expect(
      (
        await call(`/api/workspaces/${ws}/bots/${botId}/install`, owner.cookie, {
          method: "POST",
          json: { channel_id: channel },
        })
      ).status,
    ).toBe(200);
  }, 120_000);

  test("the acceptance: a mention becomes a session, a permission, a diff card and a PR", async () => {
    // The fake agent reads the first word of what it is asked; `edit` is the lane that asks for a
    // permission and then writes a file, which is the shape of the acceptance.
    const asked = (await call(`/api/workspaces/${ws}/channels/${channel}/messages`, owner.cookie, {
      method: "POST",
      json: { text: "<@dawn> edit notes.txt to add a dark-mode toggle" },
    })) as { status: number; body: MessageBody };
    expect(asked.status).toBe(201);
    const rootId = asked.body.id;
    await booted.bots.settled();

    // The session card: where the work is, and the way into it (spec §5.3).
    const card = await waitForBlock(rootId, "session_card");
    expect(card.sessionId).toBeTruthy();
    expect(card.url).toContain(`/code/`);
    expect(card.url).toContain(`?session=${card.sessionId}`);
    // The session knows which chat it belongs to, which is what makes the rest of this work.
    const session = (await call(`/api/sessions/${card.sessionId}`, owner.cookie)) as {
      body: { project_id: string; engine: string };
    };
    expect(session.body).toMatchObject({ project_id: projectId, engine: "acp" });

    // The permission, asked in the thread rather than only in the session pane.
    const permission = await waitForBlock(rootId, "approve_deny");
    expect(permission.text).toContain("Dawn wants to");
    const at = (await thread(rootId)).find((row) =>
      row.blocks.some((one) => one.id === permission.id),
    );
    expect(at).toBeDefined();

    const answered = await call(
      `/api/workspaces/${ws}/messages/${at?.id}/interactions`,
      owner.cookie,
      {
        method: "POST",
        json: { block_id: permission.id, values: { decision: "approved" } },
      },
    );
    expect(answered.status, answered.text).toBe(200);

    // And the end of it: what changed, where to open it, and the pull request it became.
    const diff = await waitForBlock(rootId, "diff_card", 90_000);
    expect(diff.summary).toContain("Done");
    expect(diff.url).toContain(`?session=${card.sessionId}`);
    expect(diff.prNumber).toBe(7);
    expect(diff.prUrl).toBe("https://github.test/o/r/pull/7");

    // The credential did all of that and is in none of it (AGENTS.md §1.6).
    expect(JSON.stringify(await thread(rootId))).not.toContain(TOKEN);
    expect(github.seen.some((one) => one.path.endsWith("/pulls") && one.method === "POST")).toBe(
      true,
    );
  }, 180_000);

  test("a bot with no project to work on says so rather than guessing", async () => {
    const bot = (await call(`/api/workspaces/${ws}/bots`, owner.cookie, {
      method: "POST",
      json: {
        handle: "dusk",
        name: "Dusk",
        visibility: "workspace",
        spec: { engine: "acp", projects: ["Nothing"], triggers: [{ on: "mention" }] },
      },
    })) as { status: number; body: { id: string } };
    expect(bot.status).toBe(201);
    expect(
      (
        await call(`/api/workspaces/${ws}/bots/${bot.body.id}/install`, owner.cookie, {
          method: "POST",
          json: { channel_id: channel },
        })
      ).status,
    ).toBe(200);
    const asked = (await call(`/api/workspaces/${ws}/channels/${channel}/messages`, owner.cookie, {
      method: "POST",
      json: { text: "<@dusk> have a look at something" },
    })) as { body: MessageBody };
    await booted.bots.settled();
    const said = (await thread(asked.body.id)).filter((row) => row.author_type === "bot");
    expect(JSON.stringify(said)).toContain("no project to work on");
    expect(said.some((row) => row.blocks.some((one) => one.type === "session_card"))).toBe(false);
  }, 60_000);
});
