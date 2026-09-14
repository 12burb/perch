#!/usr/bin/env bun
/**
 * Stands in for `codex exec --json` (task 1.11): prints the documented JSONL stream for a prompt
 * (thread.started, item.*, turn.completed), resumes a thread when asked, and records its argv so
 * the test can check the flags the harness passes.
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const log = process.env.FAKE_CLI_LOG;
if (log) appendFileSync(log, `${JSON.stringify(argv)}\n`);
const resumeAt = argv.indexOf("resume");
const threadId =
  resumeAt >= 0 ? (argv[resumeAt + 1] ?? "thread_x") : `thread_${Date.now().toString(36)}`;
const prompt = argv[argv.length - 1] ?? "";
const say = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);

say({ type: "thread.started", thread_id: threadId });
say({ type: "turn.started" });
if (prompt.startsWith("fail")) {
  say({ type: "turn.failed", error: { message: "the model refused" } });
  // The real CLIs flush and tear down after their last event; the exit arriving after the next
  // turn has started is the race the harness has to survive.
  setTimeout(() => process.exit(1), 250);
}
if (prompt.startsWith("slow")) {
  const timer = setInterval(() => {
    say({
      type: "item.completed",
      item: { id: `msg_${Date.now()}`, type: "agent_message", text: "tick " },
    });
  }, 40);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(143);
  });
} else {
  say({ type: "item.started", item: { id: "item_0", type: "reasoning", text: "thinking" } });
  say({
    type: "item.started",
    item: { id: "item_1", type: "command_execution", command: "ls -la", status: "in_progress" },
  });
  say({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "command_execution",
      command: "ls -la",
      aggregated_output: "README.md\n",
      exit_code: 0,
      status: "completed",
    },
  });
  say({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "file_change",
      status: "completed",
      changes: [{ path: `${process.cwd()}/notes.txt`, kind: "add" }],
    },
  });
  say({
    type: "item.completed",
    item: {
      id: "item_3",
      type: "agent_message",
      text: `Codex says: ${resumeAt >= 0 ? "resumed" : "fresh"} ${prompt}`,
    },
  });
  say({
    type: "turn.completed",
    usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 5 },
  });
}
