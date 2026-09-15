#!/usr/bin/env bun
/**
 * A registry-shaped ACP agent for the adapter's tests (task 1.9), built on the official SDK over
 * stdio: modes (build, plan), text chunks, tool calls with results and a diff, a permission request
 * before an edit, the client's fs capabilities, usage in the prompt response, cancellation, and a
 * prompt that fails. What it does depends on the prompt's first word.
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

type Session = { cwd: string; mode: string; pending: AbortController | null; turns: number };
const sessions = new Map<string, Session>();
const usage = { input: 0, output: 0 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runTurn(
  sessionId: string,
  session: Session,
  text: string,
  signal: AbortSignal,
  cx: acp.AgentContext,
): Promise<void> {
  const say = (delta: string) =>
    cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta } },
    });
  const notify = (update: acp.SessionNotification["update"]) =>
    cx.notify(acp.methods.client.session.update, { sessionId, update });
  // Task 1.14: the api's ⌘K prompt asks for a replacement and nothing else.
  if (text.startsWith("Perch inline edit")) {
    const fenced = /```[^\n]*\n([\s\S]*?)\n?```/.exec(text);
    const selection = fenced?.[1] ?? "";
    if (/permission/i.test(text)) {
      // Nobody is watching an inline round: the api refuses, and the agent carries on anyway.
      const answer = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: "call_inline", title: "Edit selection", kind: "edit" },
        options: [
          { kind: "allow_once", name: "Allow once", optionId: "once" },
          { kind: "reject_once", name: "Deny", optionId: "no" },
        ],
      });
      const denied = answer.outcome.outcome === "cancelled" || answer.outcome.optionId === "no";
      await say(denied ? "Denied, answering anyway.\n" : "Allowed.\n");
    }
    const rewritten = /uppercase/i.test(text)
      ? selection.toUpperCase()
      : selection
          .split("\n")
          .map((line) => (line ? `// ${line}` : line))
          .join("\n");
    await say(`Here you go:\n\`\`\`\n${rewritten}\n\`\`\`\n`);
    return;
  }
  const [word] = text.split(/\s+/);
  switch (word) {
    case "edit": {
      await say("Reading the project");
      await notify({
        sessionUpdate: "tool_call",
        toolCallId: "call_read",
        title: "Read README.md",
        kind: "read",
        status: "pending",
        rawInput: { path: `${session.cwd}/README.md` },
      });
      await notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_read",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "# Project" } }],
      });
      await notify({
        sessionUpdate: "tool_call",
        toolCallId: "call_edit",
        title: "Edit notes.txt",
        kind: "edit",
        status: "pending",
        rawInput: { path: `${session.cwd}/notes.txt` },
      });
      const permission = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: "call_edit", title: "Edit notes.txt", kind: "edit" },
        options: [
          { kind: "allow_once", name: "Allow once", optionId: "once" },
          { kind: "allow_always", name: "Always allow", optionId: "always" },
          { kind: "reject_once", name: "Deny", optionId: "no" },
        ],
      });
      if (permission.outcome.outcome === "cancelled") return;
      const allowed = permission.outcome.optionId !== "no";
      if (allowed) {
        const content = "written by the agent\n";
        await cx.request(acp.methods.client.fs.writeTextFile, {
          sessionId,
          path: `${session.cwd}/notes.txt`,
          content,
        });
        await notify({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_edit",
          status: "completed",
          content: [
            { type: "diff", path: `${session.cwd}/notes.txt`, oldText: null, newText: content },
          ],
          rawOutput: { option: permission.outcome.optionId },
        });
        await say(" and applied the edit.");
      } else {
        await notify({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_edit",
          status: "failed",
          rawOutput: { denied: true },
        });
        await say(" and skipped the edit.");
      }
      return;
    }
    case "read": {
      try {
        const file = await cx.request(acp.methods.client.fs.readTextFile, {
          sessionId,
          path: text.slice("read ".length).trim(),
        });
        await say(`file says: ${file.content.trim()}`);
      } catch (error) {
        await say(`read refused: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    case "slow": {
      for (let i = 0; i < 100 && !signal.aborted; i++) {
        await say(`tick ${i} `);
        await sleep(50);
      }
      return;
    }
    // Task 1.13: a 30-line file, then three edits far apart (three hunks), then a code block.
    case "seed": {
      const path = `${session.cwd}/notes.txt`;
      const content = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
      await notify({
        sessionUpdate: "tool_call",
        toolCallId: "call_seed",
        title: "Write notes.txt",
        kind: "edit",
        status: "pending",
        rawInput: { path },
      });
      await cx.request(acp.methods.client.fs.writeTextFile, { sessionId, path, content });
      await notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_seed",
        status: "completed",
        content: [{ type: "diff", path, oldText: null, newText: content }],
      });
      await say("Seeded notes.txt with 30 lines.");
      return;
    }
    case "spread": {
      const path = `${session.cwd}/notes.txt`;
      const file = await cx.request(acp.methods.client.fs.readTextFile, { sessionId, path });
      const edited = file.content
        .split("\n")
        .map((line) =>
          ["line 2", "line 15", "line 28"].includes(line) ? `${line} (edited)` : line,
        )
        .join("\n");
      await notify({
        sessionUpdate: "tool_call",
        toolCallId: "call_spread",
        title: "Edit notes.txt",
        kind: "edit",
        status: "pending",
        rawInput: { path },
      });
      await cx.request(acp.methods.client.fs.writeTextFile, { sessionId, path, content: edited });
      await notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_spread",
        status: "completed",
        content: [{ type: "diff", path, oldText: file.content, newText: edited }],
      });
      await say("Edited lines 2, 15, and 28.");
      return;
    }
    case "snippet":
      await say(
        "Here is a note to apply:\n```txt path=snippet.txt\nhello from a code block\n```\n",
      );
      return;
    case "mode?":
      await say(session.mode);
      return;
    // Task 1.15: which provider variables the engine was started with — names only, never values,
    // because a key must not reach a model context or a transcript (AGENTS.md §1.6).
    case "env?": {
      const names = [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "OLLAMA_HOST",
        "OPENAI_BASE_URL",
      ].filter((name) => (process.env[name] ?? "") !== "");
      await say(names.length > 0 ? `env: ${names.join(", ")}` : "env: none");
      return;
    }
    case "fail":
      throw new Error("the model is unavailable");
    default:
      await say("Hello from the fake agent");
      await say(` (turn ${session.turns}).`);
  }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

acp
  .agent({ name: "perch-fake-agent" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    authMethods: [],
  }))
  .onRequest("authenticate", () => ({}))
  .onRequest("session/new", (ctx) => {
    const sessionId = `fake-${crypto.randomUUID().slice(0, 8)}`;
    sessions.set(sessionId, { cwd: ctx.params.cwd, mode: "build", pending: null, turns: 0 });
    return {
      sessionId,
      modes: {
        currentModeId: "build",
        availableModes: [
          { id: "build", name: "Build" },
          { id: "plan", name: "Plan" },
        ],
      },
    };
  })
  .onRequest("session/set_mode", (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (session) session.mode = ctx.params.modeId;
    return {};
  })
  .onRequest("session/prompt", async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw new Error(`unknown session ${ctx.params.sessionId}`);
    const text = ctx.params.prompt
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    session.pending?.abort();
    session.pending = new AbortController();
    session.turns += 1;
    try {
      await runTurn(ctx.params.sessionId, session, text, session.pending.signal, ctx.client);
    } finally {
      // usage is cumulative across the session, as ACP specifies
      usage.input += text.length;
      usage.output += 7;
    }
    const stopReason = session.pending.signal.aborted ? "cancelled" : "end_turn";
    session.pending = null;
    return {
      stopReason,
      usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        totalTokens: usage.input + usage.output,
      },
    };
  })
  .onNotification("session/cancel", (ctx) => {
    sessions.get(ctx.params.sessionId)?.pending?.abort();
  })
  .connect(stream);
