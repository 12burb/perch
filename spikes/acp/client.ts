/**
 * The client half of spike 0.4.2: drives any ACP agent over stdio with the official SDK and returns what
 * happened. Shared by the stub-agent test and the real-agent test.
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export type PermissionAnswer = "allow" | "always" | "deny";

export type RunResult = {
  protocolVersion: number;
  sessionId: string;
  text: string;
  toolCalls: string[];
  permissionsAsked: number;
  stopReason: string;
};

export async function runAgent(
  command: string,
  args: string[],
  opts: { cwd: string; prompt: string; answer: PermissionAnswer; timeoutMs?: number },
): Promise<RunResult> {
  const proc = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], cwd: opts.cwd });
  const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));

  let permissionsAsked = 0;
  const toolCalls: string[] = [];
  let text = "";

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("acp spike timed out")), opts.timeoutMs ?? 60_000),
  );

  const run = acp
    .client({ name: "perch-spike-client" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      permissionsAsked += 1;
      const wanted = ctx.params.options.find((o) =>
        opts.answer === "allow"
          ? o.kind === "allow_once"
          : opts.answer === "always"
            ? o.kind === "allow_always"
            : o.kind === "reject_once" || o.kind === "reject_always",
      );
      const optionId = wanted?.optionId ?? ctx.params.options[0]?.optionId ?? "allow";
      return { outcome: { outcome: "selected", optionId } };
    })
    .onRequest(acp.methods.client.fs.readTextFile, () => ({ content: "" }))
    .onRequest(acp.methods.client.fs.writeTextFile, () => ({}))
    .connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      return ctx.buildSession(opts.cwd).withSession(async (session) => {
        const promptDone = session.prompt(opts.prompt);
        for (;;) {
          const message = await session.nextUpdate();
          if (message.kind === "stop") {
            const response = await promptDone;
            return {
              protocolVersion: init.protocolVersion,
              sessionId: session.sessionId,
              text,
              toolCalls,
              permissionsAsked,
              stopReason: response.stopReason,
            } satisfies RunResult;
          }
          const update = message.notification.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            text += update.content.text;
          } else if (update.sessionUpdate === "tool_call") {
            toolCalls.push(update.title);
          }
        }
      });
    });

  try {
    return await Promise.race([run, timeout]);
  } finally {
    proc.kill();
  }
}
