import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@perch/db";
import type { BusEvent } from "@perch/events";
import { connectRunner } from "@perch/runner";
import { eq } from "drizzle-orm";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import {
  authenticateRunnerToken,
  callBudget,
  createRunner,
  mintRunnerToken,
  revokeRunnerToken,
  runnerCall,
} from "../src/services/runners.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.1 (spec §3.2, §7.6): a runner with a connect token registers over /api/runner within 5 s,
 * heartbeats, answers api → runner requests through its RunnerLink, and goes offline when the socket
 * closes; bad tokens never get a socket.
 */

let booted: Booted;
let running: RunningServer;
let workspaceId = "";
const events: BusEvent[] = [];

beforeAll(async () => {
  booted = await bootTestApp(
    {},
    { runnerChannel: { heartbeatMs: 100, registerTimeoutMs: 1_000, requestTimeoutMs: 2_000 } },
  );
  booted.bus.subscribe("*", (event) => {
    if (event.type.startsWith("runner.")) events.push(event);
  });
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  const [workspace] = await booted.db.db.select().from(schema.workspaces).limit(1);
  if (!workspace) throw new Error("setup created no workspace");
  workspaceId = workspace.id;
}, 60_000);

afterAll(async () => {
  await running.stop();
});

async function runnerRow(id: string) {
  const [row] = await booted.db.db.select().from(schema.runners).where(eq(schema.runners.id, id));
  if (!row) throw new Error("runner row missing");
  return row;
}

async function until(predicate: () => boolean, ms: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("runner control channel (task 1.1)", () => {
  test("a launched runner registers within 5 s, heartbeats, serves requests, and goes offline on close", async () => {
    const runner = await createRunner(booted.db.db, {
      workspaceId,
      kind: "hosted",
      name: "pending",
    });
    const { token } = await mintRunnerToken(booted.db.db, runner.id);
    expect(token.startsWith("prt_")).toBe(true);
    expect((await runnerRow(runner.id)).status).toBe("offline");

    const started = Date.now();
    const client = connectRunner({
      apiUrl: running.url,
      token,
      name: "hosted-1",
      kind: "hosted",
      reconnect: false,
    });
    const registered = await client.registered();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(registered.runner_id).toBe(runner.id);
    expect(registered.heartbeat_ms).toBe(100);

    // The registry sees it, scoped to its workspace; the row is online with the reported capabilities.
    const entry = booted.runners.get(runner.id);
    expect(entry?.workspaceId).toBe(workspaceId);
    expect(entry?.link.info.name).toBe("hosted-1");
    expect(booted.runners.forWorkspace(workspaceId).map((r) => r.link.id)).toContain(runner.id);
    const row = await runnerRow(runner.id);
    expect(row.status).toBe("online");
    expect(row.name).toBe("hosted-1");
    expect(row.capabilities.platform).toBe(process.platform);
    expect(row.lastSeenAt).not.toBeNull();
    expect(events.map((e) => e.type)).toEqual(["runner.registered", "runner.online"]);
    expect(events[0]?.payload).toMatchObject({ workspaceId, runnerId: runner.id, kind: "hosted" });

    // Heartbeats reach the registry entry.
    await until(() => (entry?.lastHeartbeatAt ?? null) !== null, 2_000);
    expect(entry?.sessions).toEqual([]);

    // An api → runner request goes through the link with a capability token the runner accepts.
    const userId = (await booted.db.db.select().from(schema.users).limit(1))[0]?.id ?? "";
    const link = entry?.link;
    if (!link) throw new Error("no link");
    await expect(
      link.call("ports.list", { workspace_id: workspaceId, user_id: userId }),
    ).resolves.toMatchObject({
      // Real listening ports since task 1.5: this api server's own port is among them.
      ports: expect.arrayContaining([
        expect.objectContaining({ port: Number(new URL(running.url).port) }),
      ]),
    });
    // A method outside §7.6 is refused as "method not found"; an implemented one (fs.read,
    // task 1.5) runs and reports its own failure (no such project on this runner).
    const refused = await link
      .call("mcp.levitate" as "ports.list", { workspace_id: workspaceId, user_id: userId })
      .catch((e: unknown) => e);
    expect((refused as { code: number }).code).toBe(-32601);
    const missing = await link
      .call("fs.read", {
        workspace_id: workspaceId,
        user_id: userId,
        project: workspaceId,
        path: "x",
      })
      .catch((e: unknown) => e);
    expect((missing as { code: number; message: string }).code).toBe(-32603);
    expect((missing as { message: string }).message).toMatch(/project directory does not exist/);

    // Closing the runner's socket detaches it and marks it offline.
    await client.close();
    await until(() => booted.runners.get(runner.id) === undefined, 3_000);
    await until(() => events.some((e) => e.type === "runner.offline"), 3_000);
    expect((await runnerRow(runner.id)).status).toBe("offline");
    expect(booted.runnerChannel.size).toBe(0);
  });

  test("a runner that reconnects while its old socket lingers keeps the new registration (ADR-0163)", async () => {
    const runner = await createRunner(booted.db.db, { workspaceId, kind: "hosted", name: "twice" });
    const { token } = await mintRunnerToken(booted.db.db, runner.id);
    const first = connectRunner({
      apiUrl: running.url,
      token,
      name: "first-socket",
      kind: "hosted",
      reconnect: false,
    });
    await first.registered();
    expect(booted.runners.get(runner.id)?.link.info.name).toBe("first-socket");

    // The same runner again, on a new socket, before the old one has gone anywhere.
    const second = connectRunner({
      apiUrl: running.url,
      token,
      name: "second-socket",
      kind: "hosted",
      reconnect: false,
    });
    await second.registered();
    expect(booted.runners.get(runner.id)?.link.info.name).toBe("second-socket");

    // The old socket goes: the registry keeps the new link, and the row stays online.
    await first.close();
    await Bun.sleep(300);
    expect(booted.runners.get(runner.id)?.link.info.name).toBe("second-socket");
    expect((await runnerRow(runner.id)).status).toBe("online");
    const userId = (await booted.db.db.select().from(schema.users).limit(1))[0]?.id ?? "";
    await expect(
      booted.runners
        .get(runner.id)
        ?.link.call("ports.list", { workspace_id: workspaceId, user_id: userId }),
    ).resolves.toMatchObject({ ports: expect.any(Array) });

    await second.close();
    await until(() => booted.runners.get(runner.id) === undefined, 3_000);
    expect((await runnerRow(runner.id)).status).toBe("offline");
  }, 20_000);

  test("a call waits as long as its work, not as long as the link's default (ADR-0163)", async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "perch-long-call-"));
    const before = process.env.PERCH_PROJECTS_DIR;
    process.env.PERCH_PROJECTS_DIR = projectsDir;
    const runner = await createRunner(booted.db.db, { workspaceId, kind: "hosted", name: "slow" });
    const { token } = await mintRunnerToken(booted.db.db, runner.id);
    const client = connectRunner({
      apiUrl: running.url,
      token,
      name: "slow-runner",
      kind: "hosted",
      reconnect: false,
    });
    try {
      await client.registered();
      const link = booted.runners.get(runner.id)?.link;
      if (!link) throw new Error("no link");
      const userId = (await booted.db.db.select().from(schema.users).limit(1))[0]?.id ?? "";
      // The link's default here is 2 s; the command takes 3 and says it may take 6.
      const params = {
        workspace_id: workspaceId,
        user_id: userId,
        command: "sleep 3; echo slept",
        cwd: ".",
        timeout: 6_000,
      };
      expect(callBudget("exec", params)).toBe(36_000);
      expect(
        callBudget("project.setup", {
          workspace_id: workspaceId,
          user_id: userId,
          project: "x",
          source: { kind: "empty" },
        } as never),
      ).toBeGreaterThan(1_200_000);
      expect(
        callBudget("ports.list", { workspace_id: workspaceId, user_id: userId }),
      ).toBeUndefined();
      const bare = await link.call("exec", params).catch((e: unknown) => e as Error);
      expect((bare as Error).message).toContain("timed out after 2000 ms");
      const answered = (await runnerCall(link, "exec", params)) as {
        stdout: string;
        timedOut: boolean;
      };
      expect(answered.timedOut).toBe(false);
      expect(answered.stdout.trim()).toBe("slept");
    } finally {
      await client.close();
      if (before === undefined) delete process.env.PERCH_PROJECTS_DIR;
      else process.env.PERCH_PROJECTS_DIR = before;
      rmSync(projectsDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a wrong, revoked, or expired token is refused before the upgrade; a wrong kind is refused at registration", async () => {
    const res = await fetch(`${running.url}/api/runner`, {
      headers: { authorization: "Bearer prt_nope" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.details.reason).toBe("runner_token_invalid");
    expect((await fetch(`${running.url}/api/runner`)).status).toBe(403);

    const runner = await createRunner(booted.db.db, { workspaceId, kind: "local", name: "laptop" });
    const minted = await mintRunnerToken(booted.db.db, runner.id, { ttlMs: 60_000 });
    expect((await authenticateRunnerToken(booted.db.db, minted.token))?.id).toBe(runner.id);
    expect(
      await authenticateRunnerToken(booted.db.db, minted.token, new Date(Date.now() + 61_000)),
    ).toBeNull();
    expect(await revokeRunnerToken(booted.db.db, runner.id, minted.row.id)).toBe(true);
    expect(await authenticateRunnerToken(booted.db.db, minted.token)).toBeNull();

    const fresh = await mintRunnerToken(booted.db.db, runner.id);
    const client = connectRunner({
      apiUrl: running.url,
      token: fresh.token,
      kind: "hosted",
      reconnect: false,
    });
    await expect(client.registered()).rejects.toThrow(/local runner, not a hosted one/);
    await client.close();
    expect(booted.runners.get(runner.id)).toBeUndefined();
  });

  test("a socket that never registers is closed after the register timeout", async () => {
    const runner = await createRunner(booted.db.db, {
      workspaceId,
      kind: "hosted",
      name: "silent",
    });
    const { token } = await mintRunnerToken(booted.db.db, runner.id);
    const Ctor = WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const ws = new Ctor(`${running.url.replace("http", "ws")}/api/runner`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
    });
    const result = await closed;
    expect(result.code).toBe(1008);
    expect(result.reason).toContain("runner.register expected");
    expect((await runnerRow(runner.id)).status).toBe("offline");
  });
});
