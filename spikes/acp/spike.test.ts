import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runAgent } from "./client.ts";

/**
 * Spike 0.4.2 — ACP handshake (spec §9.3).
 * Pass: the ACP SDK client initializes an agent, streams a session, and answers a permission request.
 *
 * Part 1 (hermetic, runs everywhere): the SDK on Bun, both halves, against the stub agent in agent.ts.
 * Part 2 (needs credentials): any registry agent named by PERCH_SPIKE_ACP_AGENT, e.g.
 *   PERCH_SPIKE_ACP_AGENT="gemini --experimental-acp" GEMINI_API_KEY=... bun test spikes/acp
 *   PERCH_SPIKE_ACP_AGENT="npx -y @zed-industries/codex-acp" OPENAI_API_KEY=... bun test spikes/acp
 * Outcome recorded in DECISIONS.md (ADR-0030).
 */

const agentPath = join(import.meta.dir, "agent.ts");

describe("spike 0.4.2 ACP handshake (SDK on Bun)", () => {
  test("initialize → new session → prompt streams text and tool calls → permission answered → end_turn", async () => {
    const result = await runAgent(process.execPath, [agentPath], {
      cwd: import.meta.dir,
      prompt: "Update the config",
      answer: "allow",
    });
    expect(result.protocolVersion).toBeGreaterThanOrEqual(1);
    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(result.toolCalls).toEqual(["Read README.md", "Edit config.json"]);
    expect(result.permissionsAsked).toBe(1);
    expect(result.text).toBe("Reading the project and applied the edit.");
    expect(result.stopReason).toBe("end_turn");
  }, 30_000);

  test("a denied permission reaches the agent as a rejection", async () => {
    const result = await runAgent(process.execPath, [agentPath], {
      cwd: import.meta.dir,
      prompt: "Update the config",
      answer: "deny",
    });
    expect(result.permissionsAsked).toBe(1);
    expect(result.text).toBe("Reading the project and skipped the edit.");
    expect(result.stopReason).toBe("end_turn");
  }, 30_000);
});

const realAgent = process.env.PERCH_SPIKE_ACP_AGENT;

describe.skipIf(!realAgent)("spike 0.4.2 ACP handshake (real registry agent)", () => {
  test("the agent named by PERCH_SPIKE_ACP_AGENT completes a prompt", async () => {
    const [command = "", ...args] = (realAgent ?? "").split(/\s+/);
    const result = await runAgent(command, args, {
      cwd: import.meta.dir,
      prompt: "Reply with exactly the word pong and nothing else.",
      answer: "allow",
      timeoutMs: 180_000,
    });
    expect(result.text.toLowerCase()).toContain("pong");
    expect(["end_turn", "max_tokens"]).toContain(result.stopReason);
  }, 200_000);
});
