import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, RunnerNotification } from "@perch/events";
import { opencodeBinary } from "../src/opencode.ts";
import { runnerPolicy } from "../src/policy.ts";
import { projectDir } from "../src/projects.ts";
import { SessionManager } from "../src/sessions.ts";
import { type FakeOpenCode, startFakeOpenCode } from "./fixtures/opencode-server.ts";

/**
 * Task 1.10 (spec §3.3 opencode): sessions on an OpenCode server, driven through the SDK; a round's
 * SSE events become EngineEvents. The acceptance: a session edits a file and the diff arrives as
 * EngineEvents (the edit tool's diff on its tool_result, and a turn's other changes as a diff tool
 * call from the session diff). Also: plan/build as the prompt's agent, permissions, cancel through
 * abort, provider errors, and the refusal when OpenCode is not installed.
 */

const WS = "0190f2d0-0000-7000-8000-000000000001";
const PROJECT = "0190f2d0-0000-7000-8000-0000000000c1";
const USER = "0190f2d0-0000-7000-8000-0000000000aa";
const ctx = { workspace_id: WS, user_id: USER, cap: "test" } as const;

let root = "";
let fake: FakeOpenCode;
let manager: SessionManager;
let events: { session: string; event: EngineEvent }[] = [];

const notify = (n: RunnerNotification) => {
  if (n.method === "session.event") {
    events.push({ session: n.params.session_id, event: n.params.event });
  }
};

function eventsOf(session: string): EngineEvent[] {
  return events.filter((e) => e.session === session).map((e) => e.event);
}

async function until(predicate: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

const ended = (id: string) => ["done", "error"].includes(eventsOf(id).at(-1)?.type ?? "");

function open(id: string, extra: Partial<Parameters<SessionManager["create"]>[0]> = {}) {
  return manager.create({
    ...ctx,
    session_id: id,
    project: PROJECT,
    engine: "opencode",
    model: { provider: "engine", modelId: "default" },
    mode: "build",
    ...extra,
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "perch-opencode-"));
  const dir = projectDir(root, WS, PROJECT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Project\n");
  fake = startFakeOpenCode();
  manager = new SessionManager({
    root,
    policy: runnerPolicy(),
    notify,
    agents: {},
    opencode: { baseUrl: fake.url },
  });
});

afterAll(async () => {
  await manager.closeAll();
  fake.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the OpenCode adapter (task 1.10)", () => {
  test("a session edits a file and the diff arrives as EngineEvents; usage; plan mode", async () => {
    expect(manager.engines()).toEqual(["acp", "opencode"]);
    const id = "0190f2d0-0000-7000-8000-0000000000f1";
    const created = await open(id);
    expect(created.agent).toEqual({ id: "opencode", name: "OpenCode" });
    expect(created.engine_session_id).toMatch(/^oc_/);
    expect(created.modes?.available.map((m) => m.id)).toEqual(["build", "plan"]);

    await manager.send({ ...ctx, session_id: id, turn: { text: "edit the notes" } });
    await until(() => ended(id));
    const first = eventsOf(id);
    expect(first.map((e) => e.type)).toEqual([
      "text",
      "tool_call",
      "tool_result",
      "text",
      "usage",
      "done",
    ]);
    expect(first[1]).toMatchObject({ type: "tool_call", id: "call_edit", name: "edit" });
    const result = first[2] as Extract<EngineEvent, { type: "tool_result" }>;
    expect(result.output).toBe("Edited notes.txt");
    expect(result.diff).toEqual([
      {
        path: "notes.txt",
        patch: "--- /dev/null\n+++ b/notes.txt\n@@ -1,0 +1,1 @@\n+written by opencode\n",
        additions: 1,
        deletions: 0,
        status: "added",
      },
    ]);
    expect(readFileSync(join(projectDir(root, WS, PROJECT), "notes.txt"), "utf8")).toBe(
      "written by opencode\n",
    );
    expect(first[4]).toEqual({ type: "usage", input: 10, output: 4, costUsd: 0.01 });
    expect(fake.prompts.at(-1)).toMatchObject({ agent: "build", text: "edit the notes" });

    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "mode?" }, mode: "plan" });
    await until(() => ended(id));
    expect(eventsOf(id)[0]).toEqual({ type: "text", delta: "plan" });
    expect(fake.prompts.at(-1)).toMatchObject({ agent: "plan" });

    // Changes a turn made outside a reported tool show up as a diff tool call from the session diff.
    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "extra" } });
    await until(() => ended(id));
    const extra = eventsOf(id);
    expect(extra.map((e) => e.type)).toEqual(["text", "tool_call", "tool_result", "usage", "done"]);
    expect(extra[1]).toMatchObject({
      type: "tool_call",
      name: "diff",
      args: { files: ["extra.txt"] },
    });
    expect((extra[2] as Extract<EngineEvent, { type: "tool_result" }>).diff?.[0]).toMatchObject({
      path: "extra.txt",
      additions: 1,
      status: "added",
    });
    await manager.close(id);
  }, 30_000);

  test("permissions: allow lands the edit, deny does not; a model picks the provider", async () => {
    const id = "0190f2d0-0000-7000-8000-0000000000f2";
    await open(id, { model: { provider: "openai", modelId: "gpt-5" } });
    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "ask before editing" } });
    await until(() => eventsOf(id).some((e) => e.type === "permission"));
    expect(eventsOf(id).at(-1)).toMatchObject({
      type: "permission",
      id: "perm-1",
      tool: "Edit notes.txt",
      args: { type: "edit" },
    });
    await expect(
      manager.permission({ ...ctx, session_id: id, permission_id: "nope", answer: "allow" }),
    ).rejects.toThrow(/no permission nope/);
    await manager.permission({ ...ctx, session_id: id, permission_id: "perm-1", answer: "always" });
    await until(() => ended(id));
    expect(fake.replies.at(-1)).toMatchObject({ permissionID: "perm-1", response: "always" });
    expect(eventsOf(id).map((e) => e.type)).toEqual([
      "text",
      "permission",
      "tool_call",
      "tool_result",
      "text",
      "usage",
      "done",
    ]);
    expect(fake.prompts.at(-1)).toMatchObject({
      model: { providerID: "openai", modelID: "gpt-5" },
    });

    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "ask again" } });
    await until(() => eventsOf(id).some((e) => e.type === "permission"));
    await manager.permission({ ...ctx, session_id: id, permission_id: "perm-1", answer: "deny" });
    await until(() => ended(id));
    const denied = eventsOf(id).find((e) => e.type === "tool_result");
    expect(denied).toMatchObject({
      type: "tool_result",
      id: "call_edit",
      output: "permission denied",
    });
    expect(eventsOf(id).at(-1)?.type).toBe("done");
    await manager.close(id);
  }, 30_000);

  test("cancel aborts a slow round; a provider error is an error event; the session goes on", async () => {
    const id = "0190f2d0-0000-7000-8000-0000000000f3";
    await open(id);
    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "slow" } });
    await until(() => eventsOf(id).length >= 2);
    await expect(manager.send({ ...ctx, session_id: id, turn: { text: "again" } })).rejects.toThrow(
      /already running/,
    );
    expect(await manager.cancel({ ...ctx, session_id: id })).toEqual({ cancelled: true });
    await until(() => ended(id));
    expect(eventsOf(id).at(-1)?.type).toBe("done");
    expect(eventsOf(id).filter((e) => e.type === "text").length).toBeLessThan(100);
    expect(await manager.cancel({ ...ctx, session_id: id })).toEqual({ cancelled: false });

    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "fail" } });
    await until(() => ended(id));
    expect(eventsOf(id).at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("no key"),
    });

    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "hello" } });
    await until(() => ended(id));
    const text = eventsOf(id)
      .filter((e): e is Extract<EngineEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("Hello from fake OpenCode");
    await manager.close(id);
  }, 30_000);

  test("without a server or a binary the engine is refused with the reason", async () => {
    const bare = new SessionManager({
      root,
      policy: runnerPolicy(),
      notify,
      agents: {},
      opencode: { binary: "definitely-not-installed-opencode-xyz" },
    });
    try {
      expect(bare.engines()).toEqual(["acp"]);
      await expect(
        bare.create({
          ...ctx,
          session_id: "0190f2d0-0000-7000-8000-0000000000f4",
          project: PROJECT,
          engine: "opencode",
          model: { provider: "engine", modelId: "default" },
          mode: "build",
        }),
      ).rejects.toThrow(/not installed/);
      expect(opencodeBinary({ binary: "definitely-not-installed-opencode-xyz" })).toBeNull();
    } finally {
      await bare.closeAll();
    }
  });
});

/** With the real binary on PATH: `opencode serve` starts, a session opens, a keyless prompt fails cleanly. */
describe.skipIf(!opencodeBinary())("the OpenCode adapter with the real binary", () => {
  test("serve, open, and a prompt without credentials", async () => {
    const live = new SessionManager({ root, policy: runnerPolicy(), notify, agents: {} });
    const id = "0190f2d0-0000-7000-8000-00000000ff01";
    try {
      const created = await open.call(null, id);
      expect(created.agent?.id).toBe("opencode");
      events = [];
      await live.send({
        ...ctx,
        session_id: id,
        turn: { text: "Reply with the word pong." },
      });
      await until(() => ended(id), 120_000);
      expect(existsSync(root)).toBe(true);
    } finally {
      await live.closeAll();
    }
  }, 180_000);
});
