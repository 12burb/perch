import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerchBot } from "@perch/bot-sdk";
import { echoScript, FakeEngine } from "@perch/engines";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { sessionsForWorkItem } from "../src/repos/sessions.ts";
import { claimWorkItem, updateWorkItem } from "../src/repos/work.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.13 (spec §4 "Work (Plane)", §6 `work_items`, §7.1, §7.3): the acceptance is that a work
 * item is made from a message, assigned to a bot, and closed by the session that finished it.
 *
 * The last part is the point of the whole thing. Nobody drags a card here: the item is in
 * `running` because a session is running, in `needs_you` because the agent asked something, and
 * in `in_review` because the session ended — and a bot watching the board hears each move over
 * the Bot API as it happens.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let cookie = "";
let ws = "";
let channel = "";
let project = "";
let projectKey = "";

/** The agent: one question, then done, so the item visits `needs_you` on its way to review. */
const fake = new FakeEngine({
  script: (turn, ctx) => {
    if (turn.text.includes("redirect")) {
      return [
        { type: "tool_call", id: "c1", name: "fs.write", args: { path: "login.ts" } },
        { type: "permission", id: `p-${ctx.round}`, tool: "fs.write", args: { path: "login.ts" } },
        { type: "tool_result", id: "c1", output: "fixed it" },
        { type: "done" },
      ];
    }
    return echoScript(turn, ctx);
  },
});

beforeAll(async () => {
  booted = await bootTestApp({}, { engines: [fake], sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-work-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
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

type Item = {
  id: string;
  identifier: string;
  state: string;
  title: string;
  assignee_type: string | null;
  assignee_id: string | null;
  thread_root_id: string | null;
  session_id: string | null;
};

const itemNow = async (id: string): Promise<Item> =>
  ((await call(`/api/work-items/${id}`)) as { body: Item }).body;

/**
 * Waits for a project to finish setting up. `POST /projects` answers 201 with the row and sets the
 * directory up on a runner afterwards (`pending → setting_up → ready`, ADR-0069), so anything that
 * needs the runner — starting a session, most of all — is a 409 "the project is not ready yet"
 * until this returns. On an idle machine it is ready within a test or two and nobody notices; on a
 * loaded one it is not, which is what made the acceptance below fail about one CI run in ten.
 */
async function projectReady(id: string, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    const res = (await call(`/api/workspaces/${ws}/projects/${id}`)) as {
      body: { status: string; status_message: string | null };
    };
    if (res.body.status === "ready") return;
    if (res.body.status === "error" || Date.now() > until) {
      throw new Error(`the project is ${res.body.status}: ${res.body.status_message}`);
    }
    await Bun.sleep(50);
  }
}

/** Polls the item until it reaches a state, because the board follows the session on the bus. */
async function reaches(id: string, state: string, ms = 15_000): Promise<Item> {
  const until = Date.now() + ms;
  let last = await itemNow(id);
  while (Date.now() < until) {
    if (last.state === state) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await itemNow(id);
  }
  throw new Error(`the item stayed in ${last.state} instead of reaching ${state}`);
}

let itemId = "";
let botId = "";
let botToken = "";
let threadRootId = "";

describe("work items and the board (task 3.13)", () => {
  test("a workspace, a project, a bot, and a message that turns out to be work", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-work-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "The Nest" } })) as {
        body: { id: string };
      }
    ).body.id;
    channel = (
      (await call(`/api/workspaces/${ws}/channels`, {
        method: "POST",
        json: { type: "public", name: "support" },
      })) as { body: { id: string } }
    ).body.id;
    const made = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "the-site" },
    })) as { status: number; text: string; body: { id: string; key: string } };
    expect(made.status, made.text).toBe(201);
    project = made.body.id;
    projectKey = made.body.key;
    // Everything below needs its runner, so wait for the directory rather than only the row.
    await projectReady(project);

    const bot = (await call(`/api/workspaces/${ws}/bots`, {
      method: "POST",
      json: {
        handle: "dawn",
        name: "Dawn",
        visibility: "workspace",
        spec: { persona: "You fix things.", triggers: [], tools: [] },
      },
    })) as { status: number; text: string; body: { id: string } };
    expect(bot.status, bot.text).toBe(201);
    botId = bot.body.id;
    const token = (await call(`/api/workspaces/${ws}/bots/${botId}/tokens`, {
      method: "POST",
      json: { name: "watcher", scopes: ["chat:read", "channels:read"] },
    })) as { status: number; text: string; body: { token: string } };
    expect(token.status, token.text).toBe(201);
    botToken = token.body.token;

    const said = (await call(`/api/workspaces/${ws}/channels/${channel}/messages`, {
      method: "POST",
      json: { text: "the login redirect sends people to /undefined after they sign in" },
    })) as { status: number; body: { id: string } };
    expect(said.status).toBe(201);
    threadRootId = said.body.id;
  }, 60_000);

  test("made from a message: the item carries the thread it came out of, and gets its identifier", async () => {
    const made = (await call(`/api/workspaces/${ws}/projects/${project}/work-items`, {
      method: "POST",
      json: {
        title: "Fix the login redirect",
        type: "bug",
        priority: 1,
        thread_root_id: threadRootId,
      },
    })) as { status: number; text: string; body: Item };
    expect(made.status, made.text).toBe(201);
    itemId = made.body.id;
    // `KEY-123` (spec §7.8): the project's key, and the first number in it.
    expect(made.body.identifier).toBe(`${projectKey.toUpperCase()}-1`);
    expect(made.body.state).toBe("backlog");
    expect(made.body.thread_root_id).toBe(threadRootId);

    // The next one is 2, per project and never reused.
    const second = (await call(`/api/workspaces/${ws}/projects/${project}/work-items`, {
      method: "POST",
      json: { title: "Something else" },
    })) as { body: Item };
    expect(second.body.identifier).toBe(`${projectKey.toUpperCase()}-2`);

    const board = (await call(`/api/workspaces/${ws}/projects/${project}/work-items`)) as {
      body: { items: Item[]; states: string[] };
    };
    // The columns a board draws, in the order §4 names them.
    expect(board.body.states).toEqual([
      "backlog",
      "queued",
      "running",
      "needs_you",
      "in_review",
      "done",
      "cancelled",
    ]);
    // Urgent first: priority 1 beats the one with none, whichever was made first.
    expect(board.body.items[0]?.id).toBe(itemId);
  }, 60_000);

  test("assigned to a bot: the bot hears it on the Bot API, as KEY-123", async () => {
    const bot = new PerchBot({ url: base, token: botToken });
    const heard: { identifier: string; state: string; changes: string[] }[] = [];
    bot.on<{ identifier: string; state: string; changes: string[] }>(
      "work_item.updated",
      (payload) => {
        heard.push(payload);
      },
    );
    await bot.connect();
    try {
      const patched = (await call(`/api/work-items/${itemId}`, {
        method: "PATCH",
        json: { assignee: { type: "bot", id: botId }, state: "queued" },
      })) as { status: number; text: string; body: Item };
      expect(patched.status, patched.text).toBe(200);
      expect(patched.body.assignee_type).toBe("bot");
      expect(patched.body.assignee_id).toBe(botId);
      expect(patched.body.state).toBe("queued");

      const until = Date.now() + 10_000;
      while (heard.length === 0 && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(heard.length).toBeGreaterThan(0);
      expect(heard[0]?.identifier).toBe(`${projectKey.toUpperCase()}-1`);
      expect(heard[0]?.changes).toContain("assignee");
      expect(heard[0]?.changes).toContain("state");
    } finally {
      bot.disconnect();
    }
  }, 60_000);

  test("the acceptance: the session doing it moves the item, and closes it when it finishes", async () => {
    const started = (await call(`/api/work-items/${itemId}/start-session`, {
      method: "POST",
      json: { engine: "fake" },
    })) as { status: number; text: string; body: { item: Item; session_id: string } };
    expect(started.status, started.text).toBe(201);
    const sessionId = started.body.session_id;
    // Handing it to an agent is what puts it in `running` — nobody said so.
    expect(started.body.item.state).toBe("running");
    expect(started.body.item.session_id).toBe(sessionId);

    // The agent asks something, and the board says so.
    const asked = await reaches(itemId, "needs_you");
    expect(asked.session_id).toBe(sessionId);

    // Answer it. The agent finishes the round, and a session opened from a card lets itself go
    // rather than holding a runner open for a conversation nobody is having — so the item lands
    // in review, not `done`. An agent finishing is not a person agreeing (spec §4's states).
    expect(
      (
        await call(`/api/sessions/${sessionId}/permissions/p-1`, {
          method: "POST",
          json: { answer: "allow" },
        })
      ).status,
    ).toBe(200);
    const reviewed = await reaches(itemId, "in_review");
    // The session is over, so the item no longer points at one.
    expect(reviewed.session_id).toBeNull();
    const ended = (await call(`/api/sessions/${sessionId}`)) as { body: { status: string } };
    expect(ended.body.status).toBe("ended");

    // A person closes it, and that sticks: nothing on the bus drags it back.
    const closed = (await call(`/api/work-items/${itemId}`, {
      method: "PATCH",
      json: { state: "done", pr_url: "https://github.com/acme/site/pull/7" },
    })) as { status: number; body: Item & { pr_url: string } };
    expect(closed.status).toBe(200);
    expect(closed.body.state).toBe("done");
    expect(closed.body.pr_url).toBe("https://github.com/acme/site/pull/7");
  }, 120_000);

  // A stranger is told 404, not 403: somebody who is not in the workspace does not learn that the
  // item exists either (`authorize` throws not_found for non-members).
  test("a stranger's board is not yours, and they are not told it is there", async () => {
    const mine = cookie;
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Wren",
        email: `wren-work-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    try {
      expect((await call(`/api/work-items/${itemId}`)).status).toBe(404);
      expect(
        (await call(`/api/work-items/${itemId}`, { method: "PATCH", json: { state: "cancelled" } }))
          .status,
      ).toBe(404);
      expect((await call(`/api/workspaces/${ws}/projects/${project}/work-items`)).status).toBe(404);
    } finally {
      cookie = mine;
    }
    // And it is still done.
    expect((await itemNow(itemId)).state).toBe("done");
  }, 60_000);

  test("two starts at once make one agent, and the other is told it already has one (X-data-18)", async () => {
    const made = (await call(`/api/workspaces/${ws}/projects/${project}/work-items`, {
      method: "POST",
      json: { title: "Fix the logout redirect" },
    })) as { status: number; text: string; body: Item };
    expect(made.status, made.text).toBe(201);
    const id = made.body.id;
    // A double click: both arrive before either has a session. The agent asks something, so the
    // one that starts stays on the item while the other is answered.
    const both = await Promise.all(
      [0, 1].map(() =>
        call(`/api/work-items/${id}/start-session`, {
          method: "POST",
          json: { engine: "fake", prompt: "fix the redirect" },
        }),
      ),
    );
    expect(both.map((one) => one.status).sort()).toEqual([201, 409]);
    // One session, and the item points at it.
    const sessions = await sessionsForWorkItem(booted.db.db, id);
    expect(sessions).toHaveLength(1);
    const started = both.find((one) => one.status === 201)?.body as { session_id: string };
    expect((await itemNow(id)).session_id).toBe(started.session_id);
    // Let it finish, so nothing is left waiting on a person.
    await reaches(id, "needs_you");
    expect(
      (
        await call(`/api/sessions/${started.session_id}/permissions/p-1`, {
          method: "POST",
          json: { answer: "allow" },
        })
      ).status,
    ).toBe(200);
    await reaches(id, "in_review");

    // Between processes, the update itself is the claim: of two, only one finds the column empty.
    const first = await claimWorkItem(booted.db.db, id, started.session_id);
    const second = await claimWorkItem(booted.db.db, id, started.session_id);
    expect(first?.sessionId).toBe(started.session_id);
    expect(second).toBeNull();
    await updateWorkItem(booted.db.db, id, { sessionId: null, state: "in_review" });
  }, 60_000);
});
