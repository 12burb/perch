import { describe, expect, test } from "bun:test";
import type {
  ApiToRunnerMethod,
  EngineEvent,
  RunnerCallParams,
  RunnerLink,
  RunnerNotification,
} from "@perch/events";
import { runnerEngine } from "../src/runner-engine.ts";

/**
 * Task 1.8: the runner-hosted engine bridge maps createSession/send/respondPermission/cancel onto
 * §7.6 session.* calls and turns the runner's session.event notifications into the round's events.
 */

type Call = { method: ApiToRunnerMethod; params: unknown };

function fakeLink() {
  const calls: Call[] = [];
  const handlers = new Set<(n: RunnerNotification) => void>();
  let fail: string | null = null;
  const link: RunnerLink = {
    id: "runner-1",
    info: { name: "fake", kind: "hosted", capabilities: {}, versions: {} } as never,
    async call<M extends ApiToRunnerMethod>(method: M, params: RunnerCallParams<M>) {
      calls.push({ method, params });
      if (fail) throw new Error(fail);
      return {};
    },
    onNotification(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async close() {},
  };
  const emit = (sessionId: string, event: EngineEvent) => {
    for (const handler of handlers) {
      handler({ method: "session.event", params: { session_id: sessionId, event } });
    }
  };
  return {
    link,
    calls,
    emit,
    setFail: (message: string | null) => {
      fail = message;
    },
    get subscribers() {
      return handlers.size;
    },
  };
}

const sessionId = "0190f2d0-0000-7000-8000-0000000000e2";
const params = {
  sessionId,
  workspaceId: "0190f2d0-0000-7000-8000-000000000001",
  projectId: "0190f2d0-0000-7000-8000-0000000000b1",
  userId: "0190f2d0-0000-7000-8000-0000000000aa",
  model: { provider: "anthropic", modelId: "claude-sonnet-5" },
  mode: "plan" as const,
};

describe("the runner-hosted engine bridge (task 1.8)", () => {
  test("calls map onto session.* and notifications become the round", async () => {
    const fake = fakeLink();
    const engine = runnerEngine({ id: "acp", link: fake.link });
    expect(fake.subscribers).toBe(1);
    await engine.createSession({ ...params, env: { NODE_ENV: "test" } });
    expect(fake.calls[0]).toEqual({
      method: "session.create",
      params: {
        workspace_id: params.workspaceId,
        user_id: params.userId,
        session_id: sessionId,
        project: params.projectId,
        engine: "acp",
        model: params.model,
        mode: "plan",
        env: { NODE_ENV: "test" },
      },
    });

    const seen: EngineEvent[] = [];
    const round = (async () => {
      for await (const e of engine.send(sessionId, { text: "go" }, { mode: "build" })) seen.push(e);
    })();
    await Bun.sleep(5);
    expect(fake.calls[1]).toMatchObject({
      method: "session.send",
      params: { session_id: sessionId, turn: { text: "go" }, mode: "build" },
    });
    fake.emit(sessionId, { type: "text", delta: "hi" });
    fake.emit("0190f2d0-0000-7000-8000-00000000ffff", { type: "text", delta: "someone else's" });
    fake.emit(sessionId, { type: "permission", id: "p1", tool: "exec", args: {} });
    await Bun.sleep(5);
    await engine.respondPermission(sessionId, "p1", "allow");
    expect(fake.calls[2]).toMatchObject({
      method: "session.permission",
      params: { session_id: sessionId, permission_id: "p1", answer: "allow" },
    });
    fake.emit(sessionId, { type: "done" });
    await round;
    expect(seen).toEqual([
      { type: "text", delta: "hi" },
      { type: "permission", id: "p1", tool: "exec", args: {} },
      { type: "done" },
    ]);

    await engine.cancel(sessionId);
    expect(fake.calls.at(-1)).toMatchObject({ method: "session.cancel" });
    await engine.close?.(sessionId);
    await expect(engine.cancel(sessionId)).rejects.toMatchObject({ code: "unknown_session" });
    engine.dispose();
    expect(fake.subscribers).toBe(0);
  });

  test("a failed session.create leaves nothing behind; a project is required", async () => {
    const fake = fakeLink();
    const engine = runnerEngine({ id: "opencode", link: fake.link });
    fake.setFail("runner says no");
    await expect(engine.createSession(params)).rejects.toThrow(/runner says no/);
    await expect(engine.cancel(sessionId)).rejects.toMatchObject({ code: "unknown_session" });
    fake.setFail(null);
    await expect(engine.createSession({ ...params, projectId: undefined })).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
