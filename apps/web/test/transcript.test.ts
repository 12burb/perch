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
    const live = reduceTranscript(records([{ type: "text", delta: "Hel" }]), new Map(), true);
    expect(live.items[0]).toMatchObject({ kind: "text", text: "Hel", streaming: true });
  });
});
