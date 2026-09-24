import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@perch/db";
import { connectRunner } from "@perch/runner";
import { eq } from "drizzle-orm";
import { type Booted, shutdown } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { createRunner, mintRunnerToken } from "../src/services/runners.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Shutdown (ADR-0109). Closing a booted app used to depend on how many times `close()` yielded: one
 * extra `await` anywhere in it left a runner's "mark offline" write in flight while PGlite closed
 * under it, and PGlite's own `close()` spins at 100% CPU for ever when a query is in flight.
 *
 * So what these hold is the property, not the ordering: whatever has already begun, a close returns.
 * The extra tick is here on purpose — it is the thing that used to break it.
 */

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A booted app with a real runner on a real socket, the way `perch runner connect` connects one. */
async function bootWithRunner(): Promise<{
  booted: Booted;
  running: RunningServer;
  client: ReturnType<typeof connectRunner>;
}> {
  const booted = await bootTestApp({}, { runnerChannel: { heartbeatMs: 5_000 } });
  const running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  const [workspace] = await booted.db.db.select().from(schema.workspaces).limit(1);
  if (!workspace) throw new Error("setup created no workspace");
  const [membership] = await booted.db.db
    .select()
    .from(schema.memberships)
    .where(eq(schema.memberships.workspaceId, workspace.id))
    .limit(1);
  if (!membership) throw new Error("setup created no membership");
  const runner = await createRunner(booted.db.db, {
    workspaceId: workspace.id,
    kind: "local",
    name: "pending",
    ownerUserId: membership.userId,
  });
  const { token } = await mintRunnerToken(booted.db.db, runner.id);
  const projectsDir = mkdtempSync(join(tmpdir(), "perch-shutdown-"));
  dirs.push(projectsDir);
  const client = connectRunner({
    apiUrl: running.url,
    token,
    name: "a laptop",
    kind: "local",
    ownerUserId: membership.userId,
    previewHost: null,
    portsIntervalMs: 100,
    handlerOptions: { projects: { root: projectsDir } },
  });
  await client.registered();
  return { booted, running, client };
}

/** Rejects rather than hanging the whole file, so a regression fails instead of timing out. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${what} did not finish within ${ms}ms`)),
        ms,
      );
      void work.finally(() => clearTimeout(timer));
    }),
  ]);
}

describe("shutting down", () => {
  test("a close returns even when the sockets went first and a tick passed", async () => {
    const { booted, running, client } = await bootWithRunner();
    // The runner's socket is torn down by the server, not by the runner: this is what a SIGTERM
    // does, and it starts a "mark this runner offline" write from the socket's own close callback.
    running.server.stop(true);
    // The tick that used to be fatal. `apps/api/src/index.ts` and `apps/cli/src/laptop.ts` both
    // yield here for real — they await the queue worker before closing.
    await Promise.resolve();
    await within(booted.close(), 20_000, "close");
    // Closed, and closed properly: the handle refuses work rather than leaving one in flight.
    await expect(booted.db.db.select().from(schema.workspaces).execute()).rejects.toThrow();
    await client.close().catch(() => undefined);
  }, 60_000);

  test("a close returns while a query is still in flight", async () => {
    const booted = await bootTestApp({});
    // Started and deliberately not awaited: the case the drain exists for.
    const pending = booted.db.db.select().from(schema.workspaces).execute();
    await within(booted.close(), 20_000, "close");
    // It was waited for, not cut off: a query that had already started still has its answer.
    await expect(pending).resolves.toBeDefined();
  }, 60_000);

  test("a query that arrives after closing is refused, not run", async () => {
    const booted = await bootTestApp({});
    await within(booted.close(), 20_000, "close");
    await expect(booted.db.db.select().from(schema.workspaces).execute()).rejects.toThrow();
  }, 60_000);

  test("a shutdown finishes marking its runners offline before it closes the database", async () => {
    const { booted, running, client } = await bootWithRunner();
    const [before] = await booted.db.db.select().from(schema.runners).limit(1);
    expect(before?.status).toBe("online");
    // `runner.offline` is the last thing a teardown does, so seeing it means the write that comes
    // before it landed — which is the point: a restart must not find a runner still online.
    const offline: string[] = [];
    booted.bus.subscribe("runner.offline", (event) => {
      offline.push(event.payload.runnerId);
    });
    running.server.stop(true);
    await Promise.resolve();
    await within(booted.close(), 20_000, "close");
    await client.close().catch(() => undefined);
    expect(offline).toEqual([before?.id ?? ""]);
  }, 60_000);

  test("a stopping api refuses requests before anything they rely on goes (A-co-17)", async () => {
    const booted = await bootTestApp({});
    const running = serve(booted, { port: 0, hostname: "127.0.0.1" });
    expect((await fetch(`${running.url}/api/health`)).status).toBe(200);
    // The jobs worker takes a moment to stop, as it does with a job in flight. That moment, and
    // the teardown after it, is when a request used to be served with the audit, inbox and bot
    // subscribers already gone, changing state that nothing recorded.
    let release = () => {};
    const stopping = new Promise<void>((resolve) => {
      release = resolve;
    });
    let workerAsked = false;
    const down = shutdown(booted, {
      server: running,
      stops: [
        async () => {
          workerAsked = true;
          await stopping;
        },
      ],
    });
    for (const deadline = Date.now() + 10_000; !workerAsked; await Bun.sleep(10)) {
      if (Date.now() > deadline) throw new Error("the worker was never asked to stop");
    }
    const late = await fetch(`${running.url}/api/health`).then(
      (res) => res.status,
      () => "refused",
    );
    expect(late).toBe("refused");
    release();
    await within(down, 20_000, "shutdown");
    // And it closed properly behind that.
    await expect(booted.db.db.select().from(schema.workspaces).execute()).rejects.toThrow();
  }, 60_000);
});
