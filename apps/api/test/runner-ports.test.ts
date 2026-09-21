import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BusEvent, RunnerLink } from "@perch/events";
import { connectRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.5 (spec §7.6 ports.list / ports.changed, §5.6 port detection): a connected runner answers
 * the live ports route; a ports.changed notification updates the registry, shows in the Environments
 * list, and announces new ports as preview.port_detected; a runner's policy refusal is a 451.
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

async function call(path: string, cookie: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  return { status: res.status, body: (res.status === 204 ? null : await res.json()) as unknown };
}

beforeAll(async () => {
  booted = await bootTestApp({}, { runnerChannel: { heartbeatMs: 100 } });
  booted.bus.subscribe("*", (event) => {
    if (event.type.startsWith("preview.")) events.push(event);
  });
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
});

describe("runner ports (task 1.5)", () => {
  test("a connected local runner answers the live ports route; offline is a conflict", async () => {
    const owner = await signUp("Pat", "pat-ports@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Ports Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;
    const connected = (await call(`/api/workspaces/${ws}/runners/connect`, owner.cookie, {
      method: "POST",
      json: { name: "Laptop" },
    })) as { body: { runner: { id: string }; token: string } };
    const runnerId = connected.body.runner.id;
    expect(
      (await call(`/api/workspaces/${ws}/runners/${runnerId}/ports`, owner.cookie)).status,
    ).toBe(409);

    const agent = connectRunner({
      apiUrl: base,
      token: connected.body.token,
      name: "Laptop",
      kind: "local",
      portsIntervalMs: 50,
    });
    try {
      await agent.registered();
      const ports = (await call(
        `/api/workspaces/${ws}/runners/${runnerId}/ports`,
        owner.cookie,
      )) as {
        status: number;
        body: { ports: { port: number }[] };
      };
      expect(ports.status).toBe(200);
      // This very api server listens on a port the runner (same machine) can see.
      expect(ports.body.ports.some((p) => p.port === Number(new URL(base).port))).toBe(true);

      // The watcher's first report reaches the registry and the Environments list.
      const deadline = Date.now() + 5_000;
      let row: { ports: { port: number }[] } | undefined;
      while (Date.now() < deadline) {
        const list = (await call(`/api/workspaces/${ws}/runners`, owner.cookie)) as {
          body: { runners: { id: string; ports: { port: number }[] }[] };
        };
        row = list.body.runners.find((r) => r.id === runnerId);
        if (row && row.ports.length > 0) break;
        await Bun.sleep(50);
      }
      expect(row?.ports.some((p) => p.port === Number(new URL(base).port))).toBe(true);
    } finally {
      await agent.close();
    }
  }, 30_000);

  test("ports.changed announces new ports on a workspace runner; policy refusals are 451", async () => {
    const owner = await signUp("Quinn", "quinn-ports@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Preview Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;
    const hosted = (await call(`/api/workspaces/${ws}/runners/connect`, owner.cookie, {
      method: "POST",
      json: { name: "Box", kind: "remote" },
    })) as { body: { runner: { id: string } } };
    const runnerId = hosted.body.runner.id;
    const handlers = new Set<(n: { method: string; params: unknown }) => void>();
    let refuse = false;
    const stub: RunnerLink = {
      id: runnerId,
      info: { name: "Box", kind: "remote", capabilities: {}, versions: {} },
      async call(method) {
        if (refuse) throw Object.assign(new Error("policy denied: nope"), { code: -32451 });
        if (method === "ports.list") return { ports: [{ port: 5173, pid: 7 }] };
        throw Object.assign(new Error("no"), { code: -32601 });
      },
      onNotification(handler) {
        handlers.add(handler as (n: { method: string; params: unknown }) => void);
        return () => handlers.delete(handler as (n: { method: string; params: unknown }) => void);
      },
      close: async () => {},
    };
    booted.runners.attach(stub, { workspaceId: ws });
    try {
      const live = (await call(
        `/api/workspaces/${ws}/runners/${runnerId}/ports`,
        owner.cookie,
      )) as {
        body: unknown;
      };
      expect(live.body).toEqual({ ports: [{ port: 5173, pid: 7 }] });

      const emit = (ports: { port: number; pid?: number }[]) => {
        for (const handler of handlers) handler({ method: "ports.changed", params: { ports } });
      };
      emit([{ port: 5173, pid: 7 }]);
      emit([{ port: 5173, pid: 7 }, { port: 3000 }]);
      emit([{ port: 3000 }]);
      await Bun.sleep(20);
      const detected = events
        .filter((e) => e.type === "preview.port_detected")
        .map((e) => e.payload as { runnerId: string; port: number })
        .filter((p) => p.runnerId === runnerId)
        .map((p) => p.port);
      expect(detected).toEqual([5173, 3000]);
      expect(booted.runners.get(runnerId)?.ports).toEqual([{ port: 3000 }]);

      refuse = true;
      const denied = (await call(
        `/api/workspaces/${ws}/runners/${runnerId}/ports`,
        owner.cookie,
      )) as {
        status: number;
        body: { error: { code: string; message: string } };
      };
      expect(denied.status).toBe(451);
      expect(denied.body.error.code).toBe("policy_violation");
      expect(denied.body.error.message).toContain("policy denied");
    } finally {
      await booted.runners.detach(runnerId);
    }
  });
});
