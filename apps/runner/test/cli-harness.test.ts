import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, RunnerNotification } from "@perch/events";
import {
  CLI_HARNESS,
  type CliHarnessSpec,
  finished,
  parseClaude,
  parseCodex,
} from "../src/cli-harness.ts";
import { runnerPolicy } from "../src/policy.ts";
import { projectDir } from "../src/projects.ts";
import { SessionManager } from "../src/sessions.ts";
import { removeTree } from "./helpers/tmp.ts";

/**
 * Task 1.11 (spec §3.3 cli-harness, §3.6 lane C): the official CLIs in headless mode become an
 * engine on a local runner. Stand-ins for `codex exec --json` and `claude -p --output-format
 * stream-json` print the documented streams; the harness turns them into EngineEvents, resumes
 * the CLI's own session on the next turn, passes the mode as the CLI's flag, cancels by ending the
 * process, and is refused on hosted runners.
 */

const WS = "0190f2d0-0000-7000-8000-000000000001";
const PROJECT = "0190f2d0-0000-7000-8000-0000000000d1";
const USER = "0190f2d0-0000-7000-8000-0000000000aa";
const ctx = { workspace_id: WS, user_id: USER, cap: "test" } as const;
const fixtures = join(import.meta.dir, "fixtures");

let root = "";
let argvLog = "";
let manager: SessionManager;
let events: { session: string; event: EngineEvent }[] = [];
const notify = (n: RunnerNotification) => {
  if (n.method === "session.event") {
    events.push({ session: n.params.session_id, event: n.params.event });
  }
};
const eventsOf = (id: string) => events.filter((e) => e.session === id).map((e) => e.event);
const ended = (id: string) => ["done", "error"].includes(eventsOf(id).at(-1)?.type ?? "");
async function until(predicate: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}
/** The real spec's flags, run through a stand-in script instead of the CLI binary. */
function viaBun(id: string, fixture: string): CliHarnessSpec {
  const spec = CLI_HARNESS[id];
  if (!spec) throw new Error(`no spec ${id}`);
  return {
    ...spec,
    command: process.execPath,
    args: (turn) => [join(fixtures, fixture), ...spec.args(turn)],
  };
}

const argvLines = () =>
  readFileSync(argvLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[]);

/** `agent` names the CLI to run; the model is the brain it runs on (ADR-0081). */
function open(id: string, agent: string, mode: "plan" | "build" = "build") {
  return manager.create({
    ...ctx,
    session_id: id,
    project: PROJECT,
    engine: "cli-harness",
    agent,
    model: { provider: "engine", modelId: "default" },
    mode,
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "perch-cli-harness-"));
  mkdirSync(projectDir(root, WS, PROJECT), { recursive: true });
  argvLog = join(root, "argv.log");
  process.env.FAKE_CLI_LOG = argvLog;
  manager = new SessionManager({
    root,
    policy: runnerPolicy(),
    notify,
    agents: {},
    cliHarness: {
      allowed: true,
      tools: {
        codex: viaBun("codex", "fake-codex.ts"),
        claude: viaBun("claude", "fake-claude.ts"),
      },
    },
  });
});

afterAll(async () => {
  await manager.closeAll();
  delete process.env.FAKE_CLI_LOG;
  removeTree(root);
});

describe("the end of a turn", () => {
  test("the output is read to the end, not until the process exits", async () => {
    // Windows loses a whole turn to this: the CLI exits, its last JSONL lines are still in the
    // pipe, and a reader that stops at `exit` emits a bare `done`.
    const proc = new EventEmitter();
    const ending = finished(proc as never, 5_000);
    let settled = false;
    void ending.then(() => {
      settled = true;
    });
    proc.emit("exit", 0, null);
    await Bun.sleep(20);
    expect(settled).toBe(false);
    proc.emit("close", 0, null);
    expect(await ending).toEqual({ code: 0, signal: null });
  });

  test("a child that leaves its pipe open does not hang the turn", async () => {
    const proc = new EventEmitter();
    const ending = finished(proc as never, 30);
    proc.emit("exit", 3, null);
    expect(await ending).toEqual({ code: 3, signal: null });
  });

  test("a process that would not start ends the turn too", async () => {
    const proc = new EventEmitter();
    const ending = finished(proc as never, 5_000);
    proc.emit("error", new Error("ENOENT"));
    expect(await ending).toEqual({ code: null, signal: null });
  });
});

describe("the cli-harness adapter (task 1.11)", () => {
  test("codex exec --json: two turns, the thread resumed, commands and file changes as tools", async () => {
    const id = "0190f2d0-0000-7000-8000-0000000000a1";
    const created = await open(id, "codex");
    expect(created.agent).toEqual({ id: "codex", name: "Codex CLI" });
    await manager.send({ ...ctx, session_id: id, turn: { text: "list the files" } });
    await until(() => ended(id));
    const first = eventsOf(id);
    expect(first.map((e) => e.type)).toEqual([
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "text",
      "usage",
      "done",
    ]);
    expect(first[0]).toEqual({
      type: "tool_call",
      id: "item_1",
      name: "shell",
      args: { command: "ls -la" },
    });
    expect(first[1]).toMatchObject({
      type: "tool_result",
      id: "item_1",
      output: "README.md\n(exit 0)",
    });
    expect(first[2]).toMatchObject({ type: "tool_call", id: "item_2", name: "apply_patch" });
    expect(first[3]).toMatchObject({ type: "tool_result", id: "item_2", output: "add notes.txt" });
    expect(first[4]).toEqual({ type: "text", delta: "Codex says: fresh list the files" });
    expect(first[5]).toEqual({ type: "usage", input: 12, output: 5, costUsd: 0 });
    const firstArgv = argvLines().at(-1) ?? [];
    expect(firstArgv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(firstArgv).toContain("workspace-write");
    expect(firstArgv).not.toContain("resume");

    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "and again" }, mode: "plan" });
    await until(() => ended(id));
    expect(eventsOf(id).find((e) => e.type === "text")).toEqual({
      type: "text",
      delta: "Codex says: resumed and again",
    });
    const secondArgv = argvLines().at(-1) ?? [];
    const resumeAt = secondArgv.indexOf("resume");
    expect(resumeAt).toBeGreaterThan(0);
    expect(secondArgv[resumeAt + 1]).toMatch(/^thread_/);
    expect(secondArgv).toContain("read-only");
    await manager.close(id);
  }, 30_000);

  test("claude -p stream-json: text, edit diffs from the call, tool results, usage with cost, resume", async () => {
    const id = "0190f2d0-0000-7000-8000-0000000000a2";
    await open(id, "claude", "plan");
    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "change the notes" } });
    await until(() => ended(id));
    const first = eventsOf(id);
    expect(first.map((e) => e.type)).toEqual([
      "text",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "usage",
      "done",
    ]);
    expect(first[0]).toEqual({ type: "text", delta: "Claude (plan) says: fresh" });
    expect(first[1]).toMatchObject({ type: "tool_call", id: "toolu_1", name: "Edit" });
    const edit = first[2] as Extract<EngineEvent, { type: "tool_result" }>;
    expect(edit.diff).toEqual([
      {
        path: "notes.txt",
        patch: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,1 @@\n-old line\n+new line\n",
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ]);
    expect(first[3]).toMatchObject({
      type: "tool_call",
      id: "toolu_2",
      name: "Bash",
      args: { command: "bun test" },
    });
    expect(first[4]).toMatchObject({ type: "tool_result", id: "toolu_2", output: "3 pass" });
    expect(first[5]).toEqual({ type: "usage", input: 40, output: 9, costUsd: 0.0123 });
    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "more" } });
    await until(() => ended(id));
    expect(eventsOf(id)[0]).toEqual({ type: "text", delta: "Claude (plan) says: resumed" });
    const argv = argvLines().at(-1) ?? [];
    expect(argv.indexOf("--resume")).toBeGreaterThan(0);
    expect(argv[argv.indexOf("--resume") + 1]).toMatch(/^sess_/);
    expect(argv).toContain("stream-json");
    await manager.close(id);
  }, 30_000);

  test("a failing CLI is an error event; cancel ends a slow turn; no permission prompts", async () => {
    const id = "0190f2d0-0000-7000-8000-0000000000a3";
    await open(id, "codex");
    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "fail please" } });
    await until(() => ended(id));
    expect(eventsOf(id).at(-1)).toEqual({ type: "error", message: "the model refused" });
    events = [];
    await manager.send({ ...ctx, session_id: id, turn: { text: "slow" } });
    await until(() => eventsOf(id).length >= 2);
    await expect(
      manager.permission({ ...ctx, session_id: id, permission_id: "p1", answer: "allow" }),
    ).rejects.toThrow(/no permission/);
    expect(await manager.cancel({ ...ctx, session_id: id })).toEqual({ cancelled: true });
    await until(() => ended(id));
    expect(eventsOf(id).at(-1)?.type).toBe("done");
    await manager.close(id);
  }, 30_000);

  test("unknown CLIs, missing binaries, and hosted runners are refused", async () => {
    await expect(open("0190f2d0-0000-7000-8000-0000000000a4", "gemini")).rejects.toThrow(
      /unknown CLI gemini/,
    );
    const bare = new SessionManager({
      root,
      policy: runnerPolicy(),
      notify,
      agents: {},
      cliHarness: {
        allowed: true,
        tools: {
          ghost: {
            name: "Ghost",
            command: "definitely-not-installed-xyz",
            args: () => [],
            parse: () => [],
          },
        },
      },
    });
    await expect(
      bare.create({
        ...ctx,
        session_id: "0190f2d0-0000-7000-8000-0000000000a5",
        project: PROJECT,
        engine: "cli-harness",
        agent: "ghost",
        model: { provider: "engine", modelId: "default" },
        mode: "build",
      }),
    ).rejects.toThrow(/not installed/);
    await bare.closeAll();
    const hosted = new SessionManager({ root, policy: runnerPolicy(), notify, agents: {} });
    await expect(
      hosted.create({
        ...ctx,
        session_id: "0190f2d0-0000-7000-8000-0000000000a6",
        project: PROJECT,
        engine: "cli-harness",
        agent: "codex",
        model: { provider: "engine", modelId: "default" },
        mode: "build",
      }),
    ).rejects.toThrow(/local runner/);
    expect(hosted.engines()).toEqual(["acp"]);
    await hosted.closeAll();
  });

  test("the parsers ignore what they do not know", () => {
    const tools = new Map();
    const parseCtx = { cwd: "/p", session: () => {}, tools };
    expect(parseCodex({ type: "something.new" }, parseCtx)).toEqual([]);
    expect(
      parseCodex({ type: "item.completed", item: { id: "i", type: "todo_list" } }, parseCtx),
    ).toEqual([]);
    expect(parseClaude({ type: "stream_event" }, parseCtx)).toEqual([]);
    expect(
      parseClaude({ type: "result", subtype: "error_max_turns", is_error: true }, parseCtx),
    ).toEqual([
      { type: "usage", input: 0, output: 0, costUsd: 0 },
      { type: "error", message: "error_max_turns" },
    ]);
  });
});
