import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { RunnerInfo, RunnerLink, RunnerNotification } from "@perch/events";
import type { Booted } from "../src/boot.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Which lane a preview takes (ADR-0173). A runner's `preview_host` is where the api would open a
 * connection itself, from inside its own network — so it is honoured only for runners the api can
 * vouch for: hosted runners the supervisor made, and the in-process runner of laptop mode. A
 * member's own machine is reached through its tunnel whatever it says about itself, and the direct
 * lane is only ever for a port the chosen runner reported.
 */

let booted: Booted;
const attached: string[] = [];

beforeAll(async () => {
  booted = await bootTestApp({});
}, 60_000);

afterEach(async () => {
  for (const id of attached.splice(0)) await booted.runners.detach(id);
});

afterAll(async () => {
  await booted.close();
});

/** A runner link that reports whatever ports it is told to, and is never actually called. */
function fakeRunner(
  id: string,
  info: Partial<RunnerInfo> & Pick<RunnerInfo, "kind">,
  workspaceId: string | null,
) {
  const handlers = new Set<(notification: RunnerNotification) => void>();
  const link: RunnerLink = {
    id,
    info: { name: id, capabilities: {}, versions: {}, ...info },
    call: async () => {
      throw new Error("not called in this test");
    },
    onNotification: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close: async () => {},
    openStream: async () => {
      throw new Error("not opened in this test");
    },
  };
  booted.runners.attach(link, { workspaceId });
  attached.push(id);
  return {
    listening(...ports: number[]) {
      for (const handler of handlers) {
        handler({ method: "ports.changed", params: { ports: ports.map((port) => ({ port })) } });
      }
    },
  };
}

describe("preview lanes (ADR-0173)", () => {
  test("a member's local runner that names a host is still reached through its tunnel", () => {
    const ws = crypto.randomUUID();
    const laptop = crypto.randomUUID();
    fakeRunner(laptop, { kind: "local", preview_host: "10.0.0.5" }, ws).listening(8080);
    const reach = booted.previews.reach(ws, 8080);
    expect(reach.kind).toBe("tunnel");
    expect(reach.runnerId).toBe(laptop);
    expect("host" in reach).toBe(false);
  });

  test("a remote runner is treated the same way", () => {
    const ws = crypto.randomUUID();
    fakeRunner(crypto.randomUUID(), { kind: "remote", preview_host: "db.internal" }, ws).listening(
      3000,
    );
    expect(booted.previews.reach(ws, 3000).kind).toBe("tunnel");
  });

  test("a hosted runner that reported the port is proxied to directly", () => {
    const ws = crypto.randomUUID();
    const hosted = crypto.randomUUID();
    fakeRunner(hosted, { kind: "hosted", preview_host: "perch-runner-1" }, ws).listening(5173);
    const reach = booted.previews.reach(ws, 5173);
    expect(reach).toMatchObject({ kind: "direct", host: "perch-runner-1", runnerId: hosted });
  });

  test("a local runner listed first does not take a hosted runner's port", () => {
    const ws = crypto.randomUUID();
    fakeRunner(crypto.randomUUID(), { kind: "local", preview_host: "10.0.0.5" }, ws).listening(
      5173,
    );
    fakeRunner(
      crypto.randomUUID(),
      { kind: "hosted", preview_host: "perch-runner-2" },
      ws,
    ).listening(5173);
    expect(booted.previews.reach(ws, 5173)).toMatchObject({
      kind: "direct",
      host: "perch-runner-2",
    });
  });

  test("the direct lane is only for a port the runner reported", () => {
    const ws = crypto.randomUUID();
    fakeRunner(
      crypto.randomUUID(),
      { kind: "hosted", preview_host: "perch-runner-3" },
      ws,
    ).listening(5173);
    // 9000 was never reported: the api does not open a connection to it on the runner's host.
    expect(booted.previews.reach(ws, 9000).kind).toBe("tunnel");
  });

  test("the in-process runner of laptop mode keeps its loopback lane", () => {
    const ws = crypto.randomUUID();
    fakeRunner(
      `inprocess:${crypto.randomUUID()}`,
      { kind: "local", preview_host: "127.0.0.1" },
      null,
    ).listening(4321);
    expect(booted.previews.reach(ws, 4321)).toMatchObject({ kind: "direct", host: "127.0.0.1" });
  });
});
