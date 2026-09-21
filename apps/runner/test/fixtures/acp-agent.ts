#!/usr/bin/env bun
/**
 * A registry-shaped ACP agent for the adapter's tests (task 1.9), built on the official SDK over
 * stdio: modes (build, plan), text chunks, tool calls with results and a diff, a permission request
 * before an edit, the client's fs capabilities, usage in the prompt response, cancellation, and a
 * prompt that fails. What it does depends on the prompt's first word.
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type Session = {
  cwd: string;
  mode: string;
  pending: AbortController | null;
  turns: number;
  /** What session/new handed us: Perch's gateway, never a provider (task 1.17). */
  mcpServers: acp.McpServer[];
};
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
  // Task 1.20: the commit-message prompt asks for the message and nothing else.
  if (text.startsWith("Perch commit message")) {
    const touched = /^\+\+\+ b\/(.+)$/m.exec(text)?.[1] ?? "the project";
    const scope =
      touched
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "project";
    await say(`feat(${scope}): update ${touched}\n\nWritten by the fake agent from the diff.`);
    return;
  }
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
  /**
   * Task 2.16: a turn that carries a context chip from the Preview tab names the file the dev
   * plugin tagged, and the edit has to land there — which is §11's acceptance for the inspector.
   */
  const chipped = /^Context from the preview:\n([\s\S]*?)\n\n([\s\S]*)$/.exec(text);
  if (chipped) {
    const at = /\bat ([^\s:]+):(\d+):(\d+)/.exec(chipped[1] ?? "");
    const asked = (chipped[2] ?? "").trim();
    if (at?.[1]) {
      const path = `${session.cwd}/${at[1]}`;
      await say(`Editing ${at[1]}`);
      notify({
        sessionUpdate: "tool_call",
        toolCallId: "call_preview",
        title: `Edit ${at[1]}`,
        kind: "edit",
        status: "in_progress",
        rawInput: { path },
      });
      const content = `// ${asked}\nexport const App = () => null;\n`;
      await cx.request(acp.methods.client.fs.writeTextFile, { sessionId, path, content });
      notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_preview",
        status: "completed",
        content: [{ type: "diff", path, oldText: null, newText: content }],
      });
      await say(` — done.`);
      return;
    }
  }
  /**
   * Task 2.17: a turn that arrives with the codebase index in front of it answers with the files it
   * was handed and the question that followed them — which is §11's acceptance for `@codebase`
   * ("an @codebase question cites the right file") seen from the model's side.
   */
  if (text.startsWith("From this project's index")) {
    const cited = [...text.matchAll(/^([\w./-]+):(\d+)-(\d+)/gm)].map((one) => one[1] ?? "");
    const fence = text.lastIndexOf("```\n\n");
    const asked = fence < 0 ? text : text.slice(fence + 5);
    await say(`cited: ${[...new Set(cited)].join(", ")}\n`);
    await say(`asked: ${asked.trim()}`);
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
    // Task 2.13: the project's own environment, as the value itself — which is what makes the
    // transcript's redaction provable rather than assumed.
    case "secret?":
      await say(`DATABASE_URL=${process.env.DATABASE_URL ?? "none"}`);
      return;
    // The brain's credential, the same way: an engine gets it in its environment (spec §3.4), and
    // an agent asked for it will print it — which is what the transcript must never carry.
    case "key?":
      await say(`OPENAI_API_KEY=${process.env.OPENAI_API_KEY ?? "none"}`);
      return;
    // Task 1.17: the tools an MCP server gives the agent, used through whatever Perch injected.
    case "tools?": {
      const http = session.mcpServers.filter(
        (server): server is Extract<acp.McpServer, { type: "http" }> =>
          "type" in server && server.type === "http",
      );
      if (http.length === 0) {
        await say("mcp: none");
        return;
      }
      for (const server of http) {
        const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]));
        const client = new Client({ name: "fake-agent", version: "1" }, { capabilities: {} });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }),
        );
        try {
          const listed = await client.listTools();
          await say(`mcp ${server.name} tools: ${listed.tools.map((t) => t.name).join(", ")}\n`);
          const called = await client.callTool({ name: "list_issues", arguments: { repo: "o/r" } });
          const content = Array.isArray(called.content) ? called.content : [];
          const texts = content
            .map((part) => (part && part.type === "text" ? part.text : ""))
            .filter(Boolean);
          await say(`mcp ${server.name} issues: ${texts.join(" ")}\n`);
          // What the runner actually holds, so a test can prove it is not the provider's.
          await say(`mcp ${server.name} bearer: ${headers.authorization ?? "none"}\n`);
        } finally {
          await client.close().catch(() => undefined);
        }
      }
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
    sessions.set(sessionId, {
      cwd: ctx.params.cwd,
      mode: "build",
      pending: null,
      turns: 0,
      mcpServers: ctx.params.mcpServers ?? [],
    });
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
