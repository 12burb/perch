#!/usr/bin/env bun
/**
 * A minimal ACP agent built on the official SDK, spoken over stdio (ndjson). It behaves like a registry
 * agent for the spike: streams text, reports a tool call, asks for permission before an edit, and honours
 * cancellation. Used by spike.test.ts to validate the SDK on Bun end to end without vendor credentials.
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

type Session = { pending: AbortController | null };
const sessions = new Map<string, Session>();

async function runTurn(
  sessionId: string,
  signal: AbortSignal,
  cx: acp.AgentContext,
): Promise<void> {
  const notify = (update: acp.SessionNotification["update"]) =>
    cx.notify(acp.methods.client.session.update, { sessionId, update });

  await notify({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Reading the project" },
  });
  if (signal.aborted) return;
  await notify({
    sessionUpdate: "tool_call",
    toolCallId: "call_read",
    title: "Read README.md",
    kind: "read",
    status: "pending",
    locations: [{ path: "/project/README.md" }],
    rawInput: { path: "/project/README.md" },
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
    title: "Edit config.json",
    kind: "edit",
    status: "pending",
    locations: [{ path: "/project/config.json" }],
    rawInput: { path: "/project/config.json", content: "{}" },
  });
  const permission = await cx.request(acp.methods.client.session.requestPermission, {
    sessionId,
    toolCall: {
      toolCallId: "call_edit",
      title: "Edit config.json",
      kind: "edit",
      status: "pending",
      locations: [{ path: "/project/config.json" }],
      rawInput: { path: "/project/config.json", content: "{}" },
    },
    options: [
      { kind: "allow_once", name: "Allow once", optionId: "allow" },
      { kind: "allow_always", name: "Always allow", optionId: "always" },
      { kind: "reject_once", name: "Deny", optionId: "deny" },
    ],
  });
  if (permission.outcome.outcome === "cancelled") return;
  const allowed = permission.outcome.optionId !== "deny";
  await notify({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_edit",
    status: allowed ? "completed" : "failed",
    rawOutput: { applied: allowed },
  });
  await notify({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: allowed ? " and applied the edit." : " and skipped the edit." },
  });
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

acp
  .agent({ name: "perch-spike-agent" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("authenticate", () => ({}))
  .onRequest("session/new", () => {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { pending: null });
    return { sessionId };
  })
  .onRequest("session/set_mode", () => ({}))
  .onRequest("session/prompt", async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw new Error(`unknown session ${ctx.params.sessionId}`);
    session.pending?.abort();
    session.pending = new AbortController();
    await runTurn(ctx.params.sessionId, session.pending.signal, ctx.client);
    const stopReason = session.pending.signal.aborted ? "cancelled" : "end_turn";
    session.pending = null;
    return { stopReason };
  })
  .onNotification("session/cancel", (ctx) => {
    sessions.get(ctx.params.sessionId)?.pending?.abort();
  })
  .connect(stream);
