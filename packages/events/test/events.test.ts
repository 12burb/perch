import { describe, expect, test } from "bun:test";
import {
  apiToRunnerParams,
  BUS_EVENT_NAMES,
  busEventPayloads,
  engineEventSchema,
  errorResponseSchema,
  isRunnerMethod,
  jsonRpcMessageSchema,
  PERCH_ERROR_STATUS,
  parseBusPayload,
  parseRunnerParams,
  runnerToApiParams,
  wsClientOpSchema,
  wsServerEnvelopeSchema,
} from "../src/index.ts";

const SPEC_BUS_EVENTS = `workspace.updated; member.added|removed|role_changed; project.created|updated|deleted; runner.registered|online|offline; channel.created|updated|archived; message.created|updated|deleted; reaction.added|removed; thread.facts_updated; read_state.updated; presence.changed; typing; bot.installed|uninstalled|run_started|run_finished|run_failed|chain_hop|chain_breaker; session.created|delta|tool_call|tool_result|permission_requested|permission_answered|usage|done|error; diff.applied; checkpoint.created|restored; connection.created|refreshed|revoked|failed|grant_added|grant_removed; tools.called; preview.port_detected|share_created|share_revoked; work_item.created|updated|state_changed|assigned; intake.received|accepted|declined; inbox.item_created|resolved; policy.violation; usage.recorded; budget.warning|exceeded; webhook.received|delivered|failed; audit.logged`;

function expandSpecCatalog(): string[] {
  return SPEC_BUS_EVENTS.split(";").flatMap((group) => {
    const [head = "", tail] = group.trim().split(".");
    if (tail === undefined) return [head];
    return tail.split("|").map((suffix) => `${head}.${suffix}`);
  });
}

const SPEC_RUNNER_TO_API = [
  "runner.register",
  "runner.heartbeat",
  "ports.changed",
  "session.event",
  "pty.data",
  "pty.exit",
  "fs.changed",
];
const SPEC_API_TO_RUNNER =
  "session.create session.send session.permission session.cancel session.checkpoint session.restore pty.open pty.input pty.resize pty.close fs.list fs.read fs.write fs.stat fs.search git.status git.diff git.commit git.push git.branch worktree.create worktree.remove ports.list http.open mcp.spawn exec".split(
    " ",
  );

/**
 * Methods beyond the spec's list, each with an ADR: project.setup / project.remove (ADR-0069),
 * git.apply (ADR-0079), preview.screenshot (ADR-0108).
 */
const ADDITIVE_API_TO_RUNNER = [
  "project.setup",
  "project.remove",
  "project.config",
  "git.apply",
  "preview.screenshot",
];
/**
 * Events beyond the spec's catalog, each with an ADR: session.turn / session.status (ADR-0074),
 * deploy.started (ADR-0106).
 */
const ADDITIVE_BUS_EVENTS = ["session.turn", "session.status", "deploy.started"];

describe("bus event catalog (spec §7.7)", () => {
  test("every event in the spec catalog has a schema, and nothing else does", () => {
    const expected = [...expandSpecCatalog(), ...ADDITIVE_BUS_EVENTS].sort();
    expect([...BUS_EVENT_NAMES].sort() as string[]).toEqual(expected);
  });

  test("payloads validate and reject junk", () => {
    const wsId = "01926a1e-0000-7000-8000-000000000001";
    expect(
      parseBusPayload("presence.changed", { workspaceId: wsId, userId: wsId, status: "online" }),
    ).toEqual({
      workspaceId: wsId,
      userId: wsId,
      status: "online",
    });
    expect(() =>
      parseBusPayload("presence.changed", { workspaceId: wsId, status: "asleep" }),
    ).toThrow();
    expect(busEventPayloads.typing.safeParse({ workspaceId: "nope" }).success).toBe(false);
  });
});

describe("ws protocol (spec §7.2)", () => {
  test("client ops and the server envelope", () => {
    expect(wsClientOpSchema.parse({ op: "subscribe", topics: ["ws:abc", "channel:c1"] }).op).toBe(
      "subscribe",
    );
    expect(wsClientOpSchema.safeParse({ op: "subscribe", topics: ["bogus"] }).success).toBe(false);
    expect(wsClientOpSchema.parse({ op: "resume", topic: "session:s1", after_seq: 12 })).toEqual({
      op: "resume",
      topic: "session:s1",
      after_seq: 12,
    });
    const env = wsServerEnvelopeSchema.parse({
      type: "message.created",
      topic: "channel:c1",
      seq: 1,
      ts: new Date().toISOString(),
      payload: {},
    });
    expect(env.seq).toBe(1);
    expect(
      wsServerEnvelopeSchema.safeParse({ type: "x", topic: "t", seq: -1, ts: "now", payload: {} })
        .success,
    ).toBe(false);
  });
});

describe("runner protocol (spec §7.6)", () => {
  test("every method in the spec has a params schema, in the right direction", () => {
    expect(Object.keys(runnerToApiParams).sort()).toEqual([...SPEC_RUNNER_TO_API].sort());
    expect(Object.keys(apiToRunnerParams).sort()).toEqual(
      [...SPEC_API_TO_RUNNER, ...ADDITIVE_API_TO_RUNNER].sort(),
    );
    expect(isRunnerMethod("exec")).toBe(true);
    expect(isRunnerMethod("rm.rf")).toBe(false);
  });

  test("api → runner requests must carry workspace_id, user_id, and a capability token", () => {
    const base = {
      workspace_id: "01926a1e-0000-7000-8000-000000000001",
      user_id: "01926a1e-0000-7000-8000-000000000002",
      cap: "cap_x",
    };
    expect(
      parseRunnerParams("pty.open", { ...base, cols: 80, rows: 24, cwd: "/p", user: "dawn" }).cols,
    ).toBe(80);
    expect(() =>
      parseRunnerParams("pty.open", { cols: 80, rows: 24, cwd: "/p", user: "dawn" }),
    ).toThrow();
    expect(() =>
      parseRunnerParams("exec", { ...base, command: "ls", cwd: "/p", timeout: 0 }),
    ).toThrow();
  });

  test("JSON-RPC 2.0 envelopes", () => {
    expect(
      jsonRpcMessageSchema.safeParse({ jsonrpc: "2.0", id: 1, method: "ports.list", params: {} })
        .success,
    ).toBe(true);
    expect(
      jsonRpcMessageSchema.safeParse({ jsonrpc: "2.0", method: "pty.data", params: {} }).success,
    ).toBe(true);
    expect(
      jsonRpcMessageSchema.safeParse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "no" },
      }).success,
    ).toBe(true);
    expect(jsonRpcMessageSchema.safeParse({ jsonrpc: "1.0", id: 1, method: "x" }).success).toBe(
      false,
    );
  });
});

describe("engine events (spec §3.3) and errors (spec §7.8)", () => {
  test("EngineEvent union", () => {
    expect(engineEventSchema.parse({ type: "text", delta: "hi" })).toEqual({
      type: "text",
      delta: "hi",
    });
    expect(
      engineEventSchema.parse({
        type: "tool_result",
        id: "c1",
        output: "ok",
        diff: [{ path: "a.ts", patch: "@@", additions: 1, deletions: 0 }],
      }).type,
    ).toBe("tool_result");
    expect(engineEventSchema.safeParse({ type: "thought", text: "…" }).success).toBe(false);
  });

  test("error codes map to the spec's statuses", () => {
    expect(PERCH_ERROR_STATUS).toEqual({
      not_found: 404,
      forbidden: 403,
      validation: 422,
      conflict: 409,
      rate_limited: 429,
      budget_exceeded: 402,
      policy_violation: 451,
      upstream_failed: 502,
      internal: 500,
    });
    expect(
      errorResponseSchema.parse({ error: { code: "not_found", message: "no" }, request_id: "r1" })
        .error.code,
    ).toBe("not_found");
    expect(
      errorResponseSchema.safeParse({ error: { code: "teapot", message: "no" }, request_id: "r1" })
        .success,
    ).toBe(false);
  });
});
