#!/usr/bin/env bun
/**
 * Stands in for `claude -p --output-format stream-json --verbose` (task 1.11): prints the
 * documented JSONL stream (system init, assistant, user tool results, result), honours --resume,
 * and records its argv for the test.
 */
import { appendFileSync, writeSync } from "node:fs";

const argv = process.argv.slice(2);
const log = process.env.FAKE_CLI_LOG;
if (log) appendFileSync(log, `${JSON.stringify(argv)}\n`);
const resumeAt = argv.indexOf("--resume");
const sessionId =
  resumeAt >= 0 ? (argv[resumeAt + 1] ?? "sess_x") : `sess_${Date.now().toString(36)}`;
const modeAt = argv.indexOf("--permission-mode");
const mode = modeAt >= 0 ? (argv[modeAt + 1] ?? "default") : "default";
const prompt = argv[argv.length - 1] ?? "";
/** Straight to the descriptor: see the note in fake-codex.ts about a buffered pipe on Windows. */
const say = (event: Record<string, unknown>) =>
  writeSync(1, `${JSON.stringify({ ...event, session_id: sessionId })}\n`);

say({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  tools: ["Edit", "Write"],
  permissionMode: mode,
});
if (prompt.startsWith("fail")) {
  say({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "boom",
    num_turns: 1,
  });
  process.exit(1);
}
say({
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: `Claude (${mode}) says: ${resumeAt >= 0 ? "resumed" : "fresh"}` },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "Edit",
        input: {
          file_path: `${process.cwd()}/notes.txt`,
          old_string: "old line",
          new_string: "new line",
        },
      },
    ],
  },
});
say({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
  },
});
say({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "bun test" } }],
  },
});
say({
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "3 pass" }] },
    ],
  },
});
say({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Done.",
  num_turns: 2,
  total_cost_usd: 0.0123,
  usage: { input_tokens: 40, output_tokens: 9 },
});
