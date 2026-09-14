import { describe, expect, test } from "bun:test";
import { RunnerRpcError } from "@perch/events";
import { createInProcessRunner } from "../src/inprocess.ts";

const WS = "0190f2d0-0000-7000-8000-000000000001";
const USER = "0190f2d0-0000-7000-8000-0000000000aa";
const ctx = { workspace_id: WS, user_id: USER, cap: "cap-token" };

describe("in-process runner (task 0.14)", () => {
  test("registers as a local runner, heartbeats, answers ports.list, refuses the rest honestly", async () => {
    const runner = createInProcessRunner({ heartbeatMs: 0, portsIntervalMs: 0, name: "test" });
    expect(runner.info.kind).toBe("local");
    expect(runner.info.versions.bun).toBe(Bun.version);
    const seen: string[] = [];
    const off = runner.onNotification((n) => {
      seen.push(n.method);
    });
    runner.heartbeat();
    expect(seen).toEqual(["runner.heartbeat"]);
    const ports = (await runner.call("ports.list", ctx)) as { ports: unknown[] };
    expect(Array.isArray(ports.ports)).toBe(true);
    // Methods of later tasks are refused with "method not found"…
    const err = await runner
      .call("pty.open", { ...ctx, cols: 80, rows: 24, cwd: "/", user: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerRpcError);
    expect((err as RunnerRpcError).code).toBe(-32601);
    // …and the policy hook answers with the policy code (task 1.5): exec outside the projects root.
    const denied = await runner
      .call("exec", { ...ctx, command: "ls", cwd: "/", timeout: 1000 })
      .catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(RunnerRpcError);
    expect((denied as RunnerRpcError).code).toBe(-32451);
    // Params are still validated against §7.6 before refusing.
    await expect(runner.call("ports.list", { workspace_id: "nope" } as never)).rejects.toThrow();
    off();
    await runner.close();
  });
});
