import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BusEvent } from "@perch/events";
import { connectRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { findRunnerById, insertRunner } from "../src/repos/runners.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.3 (spec §3.2): a member connects a machine of their own (a local runner and its token, shown
 * once), the Environments list shows it offline then online with live registry facts, a runner's
 * owner or a workspace admin removes it, and a plain member cannot remove someone else's.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
const events: BusEvent[] = [];

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
  const cookie = cookiesFrom(res);
  const me = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as {
    id: string;
  };
  return { cookie, id: me.id };
}

async function call(
  path: string,
  cookie: string,
  init: { method?: string; json?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

type RunnerRow = {
  id: string;
  kind: string;
  name: string;
  status: string;
  owner_user_id: string | null;
  connected: boolean;
  sessions: number;
  ports: { port: number; pid?: number }[];
  platform: string | null;
};

beforeAll(async () => {
  booted = await bootTestApp({}, { runnerChannel: { heartbeatMs: 100 } });
  booted.bus.subscribe("*", (event) => {
    if (event.type.startsWith("runner.")) events.push(event);
  });
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
});

describe("runners api (task 1.3)", () => {
  test("connect a machine, see it online, and remove it", async () => {
    const owner = await signUp("Olive", "olive@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Nest" },
    })) as { status: number; body: { id: string } };
    expect(created.status).toBe(201);
    const ws = created.body.id;

    const empty = (await call(`/api/workspaces/${ws}/runners`, owner.cookie)) as {
      status: number;
      body: { runners: RunnerRow[] };
    };
    expect(empty.status).toBe(200);
    expect(empty.body.runners).toEqual([]);

    const connect = (await call(`/api/workspaces/${ws}/runners/connect`, owner.cookie, {
      method: "POST",
      json: { name: "Olive's laptop" },
    })) as { status: number; body: { runner: RunnerRow; token: string; command: string } };
    expect(connect.status).toBe(201);
    expect(connect.body.token).toMatch(/^prt_/);
    expect(connect.body.command).toBe(
      `perch runner connect ${booted.env.publicUrl} --token ${connect.body.token} --name "Olive's laptop"`,
    );
    expect(connect.body.runner).toMatchObject({
      kind: "local",
      name: "Olive's laptop",
      status: "offline",
      owner_user_id: owner.id,
      connected: false,
    });

    // The machine connects; the list shows it online with the registry's facts, live.
    const client = connectRunner({
      apiUrl: base,
      token: connect.body.token,
      name: "Olive's laptop",
      kind: "local",
      reconnect: false,
    });
    const registered = await client.registered();
    expect(registered.owner_user_id).toBe(owner.id);
    const online = (await call(`/api/workspaces/${ws}/runners`, owner.cookie)) as {
      status: number;
      body: { runners: RunnerRow[] };
    };
    expect(online.body.runners[0]).toMatchObject({
      id: connect.body.runner.id,
      status: "online",
      connected: true,
      platform: process.platform,
    });
    expect(events.map((e) => e.type)).toEqual(["runner.registered", "runner.online"]);

    // Another member cannot remove it; an admin (the workspace owner) and its owner can.
    const other = await signUp("Pat", "pat@perch.test");
    const invite = (await call(`/api/workspaces/${ws}/invites`, owner.cookie, {
      method: "POST",
      json: { email: "pat@perch.test", role: "member" },
    })) as { status: number; body: { accept_url: string } };
    expect(invite.status).toBe(201);
    const inviteToken = invite.body.accept_url.split("/invite/")[1] ?? "";
    expect(
      (await call(`/api/invites/${inviteToken}/accept`, other.cookie, { method: "POST" })).status,
    ).toBe(200);
    const forbidden = await call(
      `/api/workspaces/${ws}/runners/${connect.body.runner.id}`,
      other.cookie,
      { method: "DELETE" },
    );
    expect(forbidden.status).toBe(403);

    // Pat connects a machine of their own and removes it as its owner.
    const pats = (await call(`/api/workspaces/${ws}/runners/connect`, other.cookie, {
      method: "POST",
      json: { name: "Pat's box", kind: "remote" },
    })) as { status: number; body: { runner: RunnerRow } };
    expect(pats.body.runner.kind).toBe("remote");
    expect(pats.body.runner.owner_user_id).toBe(other.id);
    expect(
      (
        await call(`/api/workspaces/${ws}/runners/${pats.body.runner.id}`, other.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);

    // The workspace owner removes Olive's connected laptop: the socket is closed too.
    expect(
      (
        await call(`/api/workspaces/${ws}/runners/${connect.body.runner.id}`, owner.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    const started = Date.now();
    while (client.status !== "closed" && Date.now() - started < 5_000) await Bun.sleep(20);
    expect(client.status).toBe("closed");
    const after = (await call(`/api/workspaces/${ws}/runners`, owner.cookie)) as {
      status: number;
      body: { runners: RunnerRow[] };
    };
    expect(after.body.runners).toEqual([]);
    expect(
      (
        await call(`/api/workspaces/${ws}/runners/${connect.body.runner.id}`, owner.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    await client.close();
  });

  test("the shared runner is no workspace's to remove, not even its owner's (ADR-0172)", async () => {
    const owner = await signUp("Shared Owner", `shared-owner-${Date.now()}@example.test`);
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Shared runner test" },
    })) as { body: { id: string } };
    const ws = created.body.id;
    const shared = await insertRunner(booted.db.db, {
      workspaceId: null,
      kind: "hosted",
      name: "shared",
    });
    const listed = (await call(`/api/workspaces/${ws}/runners`, owner.cookie)) as {
      body: { runners: { id: string }[] };
    };
    expect(listed.body.runners.map((one) => one.id)).toContain(shared.id);
    const removed = await call(`/api/workspaces/${ws}/runners/${shared.id}`, owner.cookie, {
      method: "DELETE",
    });
    expect(removed.status).toBe(404);
    expect(await findRunnerById(booted.db.db, shared.id)).not.toBeNull();
  });
});
