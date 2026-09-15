import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { echoScript, FakeEngine } from "@perch/engines";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.10 (spec §5.7 "approval inbox: one queue …, batch approve, snooze", §7.1 `/api/inbox`).
 *
 * The acceptance is the first test: an agent asks for a permission, the inbox says so, answering it
 * from the session resolves the item. The rest covers the other queues — a mention — and the two
 * things a person can do to a row without going anywhere: put it away, or come back to it later.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";

const fake = new FakeEngine({
  script: (turn, ctx) => {
    if (turn.text.startsWith("ask:")) {
      return [
        { type: "tool_call", id: "c1", name: "fs.write", args: { path: "a.txt" } },
        { type: "permission", id: `p-${ctx.round}`, tool: "fs.write", args: { path: "a.txt" } },
        { type: "done" },
      ];
    }
    return echoScript(turn, ctx);
  },
});

beforeAll(async () => {
  booted = await bootTestApp({}, { engines: [fake], sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-inbox-api-"));
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
  const me = (await call("/api/me", cookie)) as { body: { id: string; handle: string } };
  return { cookie, id: me.body.id, handle: me.body.handle };
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

type Item = {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  status: string;
  title: string;
  body: string;
  url: string | null;
  snoozed_until: string | null;
};

describe("the inbox (task 2.10)", () => {
  let ada = { cookie: "", id: "", handle: "" };
  let bo = { cookie: "", id: "", handle: "" };
  let ws = "";
  let project = "";
  let channel = "";

  const inbox = async (cookie: string, query = "") => {
    const res = (await call(`/api/inbox${query}`, cookie)) as {
      body: { items: Item[]; open: number };
    };
    return res.body;
  };

  const untilItem = async (cookie: string, kind: string): Promise<Item> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = (await inbox(cookie)).items.find((row) => row.kind === kind);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no ${kind} item arrived`);
      await Bun.sleep(20);
    }
  };

  beforeAll(async () => {
    const stamp = Date.now();
    ada = await signUp("Ada", `ada-inbox-${stamp}@perch.test`);
    bo = await signUp("Bo", `bo-inbox-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", ada.cookie, {
      method: "POST",
      json: { name: "Inbox Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, ada.cookie, {
      method: "POST",
      json: { email: `bo-inbox-${stamp}@perch.test`, role: "member" },
    })) as { body: { accept_url: string } };
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    expect((await call(`/api/invites/${token}/accept`, bo.cookie, { method: "POST" })).status).toBe(
      200,
    );
    const room = (await call(`/api/workspaces/${ws}/channels`, ada.cookie, {
      method: "POST",
      json: { type: "public", name: "general" },
    })) as { body: { id: string } };
    channel = room.body.id;
    expect(
      (
        await call(`/api/workspaces/${ws}/channels/${channel}/members`, bo.cookie, {
          method: "POST",
          json: {},
        })
      ).status,
    ).toBe(200);
    project = await readyProject(ada.cookie, ws, "Agentic");
  }, 90_000);

  test("a permission an agent is waiting on lands in the inbox, and answering it clears it", async () => {
    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, ada.cookie, {
      method: "POST",
      json: { engine: "fake", title: "Write a file", prompt: "ask: write a file" },
    })) as { status: number; body: { id: string } };
    expect(created.status).toBe(201);
    const session = created.body.id;

    const item = await untilItem(ada.cookie, "permission");
    expect(item).toMatchObject({
      kind: "permission",
      ref_type: "session_permission",
      ref_id: `${session}:p-1`,
      status: "open",
      title: "Write a file",
      body: "fs.write",
    });
    expect(item.url).toContain(`session=${session}`);
    // It is Ada's: the queue is personal, and nobody else is asked.
    expect((await inbox(bo.cookie)).items).toHaveLength(0);

    const answered = await call(`/api/sessions/${session}/permissions/p-1`, ada.cookie, {
      method: "POST",
      json: { answer: "allow" },
    });
    expect(answered.status).toBe(200);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const still = (await inbox(ada.cookie)).items.find((row) => row.id === item.id);
      if (!still) break;
      if (Date.now() > deadline) throw new Error("the permission item stayed open");
      await Bun.sleep(20);
    }
    const resolved = (await inbox(ada.cookie, "?status=resolved")).items.find(
      (row) => row.id === item.id,
    );
    expect(resolved?.status).toBe("resolved");
  }, 60_000);

  test("being named puts one line in the inbox of whoever was named", async () => {
    const said = (await call(`/api/workspaces/${ws}/channels/${channel}/messages`, ada.cookie, {
      method: "POST",
      json: { text: `<@${bo.handle}> can you look at the deploy?` },
    })) as { status: number; body: { id: string } };
    expect(said.status).toBe(201);

    const item = await untilItem(bo.cookie, "mention");
    expect(item).toMatchObject({ ref_type: "message", ref_id: said.body.id, status: "open" });
    expect(item.title).toBe("Ada named you in #general");
    expect(item.body).toContain("look at the deploy");
    expect(item.url).toContain(`/home/${channel}`);
    // Naming yourself is not something that needs you.
    expect((await inbox(ada.cookie)).items.some((row) => row.kind === "mention")).toBe(false);
  }, 60_000);

  test("put it away, or come back to it later", async () => {
    const item = (await inbox(bo.cookie)).items[0];
    if (!item) throw new Error("nothing in the inbox to act on");

    const snoozed = (await call(`/api/inbox/${item.id}/snooze`, bo.cookie, {
      method: "POST",
      json: { until: new Date(Date.now() + 60_000).toISOString() },
    })) as { status: number; body: Item };
    expect(snoozed.status).toBe(200);
    expect(snoozed.body.status).toBe("snoozed");
    // Asleep is out of the queue, and in the one place that shows what is asleep.
    expect((await inbox(bo.cookie)).items.some((row) => row.id === item.id)).toBe(false);
    expect(
      (await inbox(bo.cookie, "?status=snoozed")).items.some((row) => row.id === item.id),
    ).toBe(true);
    // A snooze that has run out is open again, without anything having to sweep the table.
    await call(`/api/inbox/${item.id}/snooze`, bo.cookie, {
      method: "POST",
      json: { until: new Date(Date.now() + 1_000).toISOString() },
    });
    await Bun.sleep(1_100);
    expect((await inbox(bo.cookie)).items.some((row) => row.id === item.id)).toBe(true);

    const done = (await call(`/api/inbox/${item.id}/resolve`, bo.cookie, {
      method: "POST",
    })) as { status: number; body: Item };
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("resolved");
    expect((await inbox(bo.cookie)).items.some((row) => row.id === item.id)).toBe(false);

    // Somebody else's row is not there to act on at all.
    expect(
      (await call(`/api/inbox/${item.id}/resolve`, ada.cookie, { method: "POST" })).status,
    ).toBe(404);
    // A snooze into the past is not a snooze.
    expect(
      (
        await call(`/api/inbox/${item.id}/snooze`, bo.cookie, {
          method: "POST",
          json: { until: new Date(Date.now() - 1_000).toISOString() },
        })
      ).status,
    ).toBe(422);
  }, 60_000);
});
