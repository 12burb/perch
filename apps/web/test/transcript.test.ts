import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@perch/events";
import { reduceTranscript } from "../src/code/transcript.ts";

/** Task 1.12: the transcript reducer folds session events into the pane's items. */

const records = (events: SessionEvent[]) => events.map((event, i) => ({ seq: i + 1, event }));

describe("reduceTranscript", () => {
  test("turns, folded text, tool cards with results and diffs, a pending permission, usage", () => {
    const result = reduceTranscript(
      records([
        { type: "turn", text: "edit the notes", mode: "build", userId: "u" },
        { type: "text", delta: "Reading" },
        { type: "text", delta: " the project" },
        { type: "tool_call", id: "call_1", name: "Read README.md", args: { path: "README.md" } },
        { type: "tool_result", id: "call_1", output: "# Project" },
        { type: "tool_call", id: "call_2", name: "Edit notes.txt", args: {} },
        { type: "permission", id: "p1", tool: "Edit notes.txt", args: { path: "notes.txt" } },
      ]),
    );
    expect(result.items.map((i) => i.kind)).toEqual(["turn", "text", "tool", "tool", "permission"]);
    expect(result.items[0]).toMatchObject({ kind: "turn", turn: 1 });
    expect(result.items[1]).toMatchObject({
      kind: "text",
      text: "Reading the project",
      streaming: false,
    });
    expect(result.items[2]).toMatchObject({ kind: "tool", status: "done", output: "# Project" });
    expect(result.items[3]).toMatchObject({ kind: "tool", status: "running" });
    expect(result.pendingPermission).toBe("p1");
    expect(result.usage).toEqual({ input: 0, output: 0, costUsd: 0 });

    const answered = reduceTranscript(
      records([
        { type: "turn", text: "edit the notes", mode: "build", userId: "u" },
        { type: "tool_call", id: "call_2", name: "Edit notes.txt", args: {} },
        { type: "permission", id: "p1", tool: "Edit notes.txt", args: {} },
        {
          type: "tool_result",
          id: "call_2",
          output: "wrote",
          diff: [{ path: "notes.txt", patch: "+x", additions: 1, deletions: 0, status: "added" }],
        },
        { type: "text", delta: " done." },
        { type: "usage", input: 10, output: 5, costUsd: 0.25 },
        { type: "done" },
      ]),
      new Map([["p1", "allow" as const]]),
    );
    expect(answered.pendingPermission).toBeNull();
    expect(answered.items[2]).toMatchObject({ kind: "permission", answer: "allow" });
    expect(answered.items[1]).toMatchObject({
      kind: "tool",
      status: "done",
      diff: [{ path: "notes.txt" }],
    });
    expect(answered.items[3]).toMatchObject({ kind: "text", text: " done.", streaming: false });
    expect(answered.usage).toEqual({ input: 10, output: 5, costUsd: 0.25 });
  });

  test("an error closes running tools and text; a live reply streams until done", () => {
    const failed = reduceTranscript(
      records([
        { type: "tool_call", id: "c", name: "shell", args: {} },
        { type: "text", delta: "oops" },
        { type: "error", message: "the model is down" },
      ]),
    );
    expect(failed.items.map((i) => i.kind)).toEqual(["tool", "text", "error"]);
    expect(failed.items[0]).toMatchObject({ status: "error" });
    const live = reduceTranscript(records([{ type: "text", delta: "Hel" }]), new Map(), "running");
    expect(live.items[0]).toMatchObject({ kind: "text", text: "Hel", streaming: true });
  });
});

describe("reduceTranscript (task 1.13)", () => {
  test("turns are numbered and a restore is a marker", () => {
    const result = reduceTranscript(
      records([
        { type: "turn", text: "seed", mode: "build", userId: "u" },
        { type: "text", delta: "done" },
        { type: "done" },
        { type: "turn", text: "spread", mode: "build", userId: "u" },
        { type: "done" },
        { type: "restore", turn: 1, gitRef: "abc", userId: "u" },
        { type: "turn", text: "again", mode: "plan", userId: "u" },
      ]),
    );
    expect(
      result.items.map((i) =>
        i.kind === "turn" || i.kind === "restore" ? `${i.kind}:${i.turn}` : i.kind,
      ),
    ).toEqual(["turn:1", "text", "turn:2", "restore:1", "turn:3"]);
  });
});

describe("reduceTranscript: replayed permissions (A-wc-14)", () => {
  const asked = (id: string): SessionEvent => ({
    type: "permission",
    id,
    tool: "Edit notes.txt",
    args: {},
  });
  const permissions = (result: ReturnType<typeof reduceTranscript>) =>
    result.items.filter((item) => item.kind === "permission");

  test("a permission the round moved past is answered, with no answer seen live", () => {
    const result = reduceTranscript(
      records([
        { type: "turn", text: "edit", mode: "build", userId: "u" },
        { type: "tool_call", id: "c1", name: "Edit notes.txt", args: {} },
        asked("p1"),
        { type: "tool_result", id: "c1", output: "wrote" },
        { type: "done" },
      ]),
      new Map(),
      "idle",
    );
    expect(permissions(result)).toEqual([expect.objectContaining({ answer: "answered" })]);
    expect(result.pendingPermission).toBeNull();
  });

  test("only the last permission of a session that needs you is live; earlier ones are answered", () => {
    const result = reduceTranscript(
      records([
        { type: "turn", text: "edit", mode: "build", userId: "u" },
        asked("p1"),
        { type: "tool_result", id: "c1", output: "wrote" },
        asked("p2"),
      ]),
      new Map(),
      "needs_you",
    );
    const [first, second] = permissions(result);
    expect(first).toMatchObject({ id: "p1", answer: "answered" });
    expect(second).toMatchObject({ id: "p2" });
    expect(second && "answer" in second ? second.answer : undefined).toBeUndefined();
    expect(result.pendingPermission).toBe("p2");
  });

  test("a session that is no longer waiting has no live permission, even as its last record", () => {
    for (const status of ["idle", "ended", "error"] as const) {
      const result = reduceTranscript(records([asked("p1")]), new Map(), status);
      expect(permissions(result)).toEqual([expect.objectContaining({ answer: "answered" })]);
      expect(result.pendingPermission).toBeNull();
    }
  });

  test("a permission that just arrived, before the status says so, is live; a round that ended is not", () => {
    const fresh = reduceTranscript(records([asked("p1")]), new Map(), "running");
    expect(fresh.pendingPermission).toBe("p1");
    // Parked after the round ended: the status says needs_you, but the old permission is gone.
    const parked = reduceTranscript(
      records([asked("p1"), { type: "done" }]),
      new Map(),
      "needs_you",
    );
    expect(parked.pendingPermission).toBeNull();
    expect(permissions(parked)).toEqual([expect.objectContaining({ answer: "answered" })]);
  });

  test("an answer seen live is kept as it was given", () => {
    const result = reduceTranscript(
      records([asked("p1"), { type: "done" }]),
      new Map([["p1", "deny" as const]]),
      "idle",
    );
    expect(permissions(result)).toEqual([expect.objectContaining({ answer: "deny" })]);
  });
});
