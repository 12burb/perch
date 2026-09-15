import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, RunnerNotification } from "@perch/events";
import { pickMode, resolveAgentLaunch, selectPermissionOption } from "../src/acp.ts";
import { runnerPolicy } from "../src/policy.ts";
import { projectDir } from "../src/projects.ts";
import { SessionManager } from "../src/sessions.ts";

/**
 * Task 1.9 (spec §3.3 acp, §7.6 session.*): a registry-shaped agent (test/fixtures/acp-agent.ts)
 * is spawned per session; two turns complete with one permission prompt; the agent's edit lands
 * through the client's fs capability with a diff in the tool result; modes map onto the agent's;
 * cancel ends a slow turn; deny reaches the agent; a failing prompt is an error event; paths
 * outside the session's directory are refused; unknown or absent agents are refused at create.
 */

const WS = "0190f2d0-0000-7000-8000-000000000001";
const PROJECT = "0190f2d0-0000-7000-8000-0000000000b1";
const USER = "0190f2d0-0000-7000-8000-0000000000aa";
const ctx = { workspace_id: WS, user_id: USER, cap: "test" } as const;
const fixture = join(import.meta.dir, "fixtures", "acp-agent.ts");
const agents = {
  fake: { name: "Fake Agent", command: process.execPath, args: [fixture] },
  ghost: { name: "Ghost", command: "definitely-not-installed-anywhere-xyz" },
};

let root = "";
let events: { session: string; event: EngineEvent }[] = [];
const notifications: RunnerNotification[] = [];
let manager: SessionManager;

const notify = (n: RunnerNotification) => {
  notifications.push(n);
  if (n.method === "session.event")
    events.push({ session: n.params.session_id, event: n.params.event });
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

function newSession(id: string, extra: Partial<Parameters<SessionManager["create"]>[0]> = {}) {
  return manager.create({
    ...ctx,
    session_id: id,
    project: PROJECT,
    engine: "acp",
    model: { provider: "fake", modelId: "default" },
    mode: "build",
    ...extra,
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "perch-acp-"));
  const dir = projectDir(root, WS, PROJECT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Project\n");
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  manager = new SessionManager({
    root,
    policy: runnerPolicy(),
    notify,
    agents,
    defaultAgent: "fake",
  });
});

afterAll(async () => {
  await manager.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("the ACP adapter (task 1.9)", () => {
  test("two turns with one permission prompt: the edit lands with a diff, usage per turn, modes", async () => {
    const id = "0190f2d0-0000-7000-8000-0000000000e1";
    const created = await newSession(id);
    expect(created.agent).toEqual({ id: "fake", name: "Fake Agent" });
    expect(created.engine_session_id).toMatch(/^fake-/);
    expect(created.modes).toEqual({
      current: "build",
      available: [
        { id: "build", name: "Build" },
        { id: "plan", name: "Plan" },
      ],
    });

    expect(
      await manager.send({ ...ctx, session_id: id, turn: { text: "edit the notes" } }),
    ).toEqual({
      started: true,
    });
    await until(() => eventsOf(id).some((e) => e.type === "permission"));
    const first = eventsOf(id);
    expect(first.map((e) => e.type)).toEqual([
      "text",
      "tool_call",
      "tool_result",
      "tool_call",
      "permission",
    ]);
    expect(first[1]).toMatchObject({ type: "tool_call", id: "call_read", name: "Read README.md" });
    expect(first[2]).toMatchObject({ type: "tool_result", id: "call_read", output: "# Project" });
    const permission = first[4] as Extract<EngineEvent, { type: "permission" }>;
    expect(permission).toMatchObject({ id: "p1", tool: "Edit notes.txt" });
    // A wrong id is refused; a round already running is refused.
    await expect(
      manager.permission({ ...ctx, session_id: id, permission_id: "nope", answer: "allow" }),
    ).rejects.toThrow(/no permission nope/);
    await expect(manager.send({ ...ctx, session_id: id, turn: { text: "again" } })).rejects.toThrow(
      /already running/,
    );
    expect(
      await manager.permission({ ...ctx, session_id: id, permission_id: "p1", answer: "always" }),
    ).toEqual({
      answered: true,
    });
    await until(() => eventsOf(id).at(-1)?.type === "done");
    const done = eventsOf(id);
    expect(done.map((e) => e.type)).toEqual([
      "text",
      "tool_call",
      "tool_result",
      "tool_call",
      "permission",
      "tool_result",
      "text",
      "usage",
      "done",
    ]);
    const result = done[5] as Extract<EngineEvent, { type: "tool_result" }>;
    expect(result.id).toBe("call_edit");
    expect(result.diff).toEqual([
      {
        path: "notes.txt",
        patch: "--- /dev/null\n+++ b/notes.txt\n@@ -1,0 +1,1 @@\n+written by the agent\n",
        additions: 1,
        deletions: 0,
        status: "added",
      },
    ]);
    expect(readFileSync(join(projectDir(root, WS, PROJECT), "notes.txt"), "utf8")).toBe(
      "written by the agent\n",
    );
    expect(
      notifications.some((n) => n.method === "fs.changed" && n.params.paths[0] === "notes.txt"),
    ).toBe(true);
    expect(done[7]).toMatchObject({ type: "usage", input: "edit the notes".length, output: 7 });

    // The second turn, in plan mode: the agent's mode switches and usage is this turn's share.
    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "mode?" }, mode: "plan" });
    await until(() => eventsOf(id).at(-1)?.type === "done");
    const second = eventsOf(id);
    expect(second.map((e) => e.type)).toEqual(["text", "usage", "done"]);
    expect(second[0]).toEqual({ type: "text", delta: "plan" });
    expect(second[1]).toMatchObject({ type: "usage", input: "mode?".length, output: 7 });
    await manager.close(id);
    expect(manager.has(id)).toBe(false);
  }, 30_000);

  test("cancel ends a slow round; deny reaches the agent; a failing prompt is an error event", async () => {
    const id = "0190f2d0-0000-7000-8000-0000000000e2";
    await newSession(id);
    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "slow" } });
    await until(() => eventsOf(id).length >= 2);
    expect(await manager.cancel({ ...ctx, session_id: id })).toEqual({ cancelled: true });
    await until(() => eventsOf(id).at(-1)?.type === "done");
    expect(eventsOf(id).filter((e) => e.type === "text").length).toBeLessThan(100);
    expect(await manager.cancel({ ...ctx, session_id: id })).toEqual({ cancelled: false });

    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "edit" } });
    await until(() => eventsOf(id).some((e) => e.type === "permission"));
    await manager.permission({ ...ctx, session_id: id, permission_id: "p1", answer: "deny" });
    await until(() => eventsOf(id).at(-1)?.type === "done");
    const denied = eventsOf(id);
    expect(denied.find((e) => e.type === "tool_result" && e.id === "call_edit")).toMatchObject({
      output: '{"denied":true}',
    });
    expect(denied.filter((e) => e.type === "text").at(-1)).toEqual({
      type: "text",
      delta: " and skipped the edit.",
    });

    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "fail" } });
    await until(() => eventsOf(id).at(-1)?.type === "error");
    expect(eventsOf(id).at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("unavailable"),
    });
    // The session survives a failed round.
    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "hello" } });
    await until(() => eventsOf(id).at(-1)?.type === "done");
    expect(eventsOf(id)[0]).toEqual({ type: "text", delta: "Hello from the fake agent" });
    await manager.close(id);
  }, 30_000);

  test("the fs capability stays inside the session's directory and the policy", async () => {
    const id = "0190f2d0-0000-7000-8000-0000000000e3";
    await newSession(id);
    const dir = projectDir(root, WS, PROJECT);
    const ask = async (path: string) => {
      events = [];
      await manager.send({ ...ctx, session_id: id, turn: { text: `read ${path}` } });
      await until(() => eventsOf(id).at(-1)?.type === "done");
      return (eventsOf(id)[0] as { delta: string }).delta;
    };
    expect(await ask(join(dir, "README.md"))).toBe("file says: # Project");
    expect(await ask(join(dir, "..", "..", "outside.txt"))).toMatch(/read refused: .*outside/);
    expect(await ask("/etc/hostname")).toMatch(/read refused/);
    expect(await ask(join(dir, ".git", "HEAD"))).toMatch(/read refused|file says: ref/);
    await manager.close(id);
  }, 30_000);

  test("unknown engines and agents, absent binaries, and missing projects are refused", async () => {
    await expect(
      newSession("0190f2d0-0000-7000-8000-0000000000e4", { engine: "cli-harness" }),
    ).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      newSession("0190f2d0-0000-7000-8000-0000000000e5", { agent: "nope" }),
    ).rejects.toThrow(/unknown ACP agent nope/);
    await expect(
      newSession("0190f2d0-0000-7000-8000-0000000000e6", { agent: "ghost" }),
    ).rejects.toThrow(/not installed/);
    await expect(
      newSession("0190f2d0-0000-7000-8000-0000000000e7", {
        project: "0190f2d0-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toThrow(/not on this runner/);
    expect(manager.availableAgents()).toEqual(["fake"]);
    // No agent named means the runner's default, whatever brain the model names (ADR-0081).
    const id = "0190f2d0-0000-7000-8000-0000000000e8";
    const created = await newSession(id, { model: { provider: "openai", modelId: "gpt-5" } });
    expect(created.agent?.id).toBe("fake");
    await manager.close(id);
  }, 30_000);

  test("helpers: launch resolution, mode mapping, permission options", () => {
    expect(
      resolveAgentLaunch({ name: "x", command: "definitely-not-installed-anywhere-xyz" }),
    ).toBeNull();
    expect(
      resolveAgentLaunch({ name: "bun", command: process.execPath, args: ["--version"] }),
    ).toEqual({
      file: process.execPath,
      args: ["--version"],
    });
    const modes = [
      { id: "code", name: "Code" },
      { id: "plan", name: "Plan" },
    ];
    expect(pickMode("plan", modes)).toBe("plan");
    expect(pickMode("build", modes)).toBe("code");
    expect(pickMode("plan", [{ id: "default", name: "Default" }])).toBeNull();
    expect(
      pickMode("build", [
        { id: "architect", name: "Architect (plan)" },
        { id: "act", name: "Act" },
      ]),
    ).toBe("act");
    const options = [
      { kind: "allow_once" as const, name: "Once", optionId: "o" },
      { kind: "reject_always" as const, name: "Never", optionId: "n" },
    ];
    expect(selectPermissionOption(options, "allow")).toEqual({
      outcome: { outcome: "selected", optionId: "o" },
    });
    expect(selectPermissionOption(options, "always")).toEqual({
      outcome: { outcome: "selected", optionId: "o" },
    });
    expect(selectPermissionOption(options, "deny")).toEqual({
      outcome: { outcome: "selected", optionId: "n" },
    });
    expect(selectPermissionOption(options, "cancelled")).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });
});

const realAgent = process.env.PERCH_ACP_TEST_AGENT;

/**
 * The acceptance with a real registry agent and its credentials, e.g.
 *   PERCH_ACP_TEST_AGENT=gemini GEMINI_API_KEY=… bun test apps/runner/test/acp.test.ts
 *   PERCH_ACP_TEST_AGENT=codex OPENAI_API_KEY=… bun test apps/runner/test/acp.test.ts
 */
describe.skipIf(!realAgent)("the ACP adapter with a real registry agent", () => {
  test("two turns complete", async () => {
    const live = new SessionManager({ root, policy: runnerPolicy(), notify });
    const id = "0190f2d0-0000-7000-8000-00000000ee01";
    try {
      await live.create({
        ...ctx,
        session_id: id,
        project: PROJECT,
        engine: "acp",
        agent: realAgent ?? "gemini",
        model: { provider: "engine", modelId: "default" },
        mode: "build",
      });
      for (const prompt of [
        "Reply with exactly the word pong and nothing else.",
        "Now reply with ping.",
      ]) {
        events = [];
        await live.send({ ...ctx, session_id: id, turn: { text: prompt } });
        await until(() => ["done", "error"].includes(eventsOf(id).at(-1)?.type ?? ""), 180_000);
        expect(eventsOf(id).at(-1)?.type).toBe("done");
      }
    } finally {
      await live.closeAll();
    }
  }, 400_000);
});
