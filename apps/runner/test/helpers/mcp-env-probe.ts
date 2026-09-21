/**
 * Runs in a child process whose real environment carries PERCH_RUNNER_TOKEN (mcp.test.ts): starts
 * the stand-in MCP server through the runner's host, asks it what it can see of the token, and
 * prints the answer. A process started with no `env` inherits the real environment of its parent,
 * not the `process.env` object a test can edit — so the leak, and the fix, are only visible from
 * outside.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocal } from "@perch/connect";
import { McpHost } from "../../src/mcp.ts";
import { runnerPolicy } from "../../src/policy.ts";
import { projectDir } from "../../src/projects.ts";
import { createStreamPair } from "../../src/streams.ts";

const WS = "0190f2d0-0000-7000-8000-000000000001";
const PROJECT = "0190f2d0-0000-7000-8000-0000000000d1";
const root = realpathSync(mkdtempSync(join(tmpdir(), "perch-mcp-probe-")));
mkdirSync(projectDir(root, WS, PROJECT), { recursive: true });
const host = new McpHost({ root, policy: runnerPolicy() });
try {
  const { stream_token } = host.spawn({
    workspace_id: WS,
    user_id: "0190f2d0-0000-7000-8000-0000000000aa",
    cap: "test",
    command: process.execPath,
    args: [join(import.meta.dir, "..", "fixtures", "stdio-mcp.ts")],
    project: PROJECT,
  });
  const pair = createStreamPair();
  if (!host.attachToken(stream_token, pair.a)) throw new Error("the stream was not attached");
  const client = await openLocal(pair.b);
  try {
    const seen = await client.callTool({ name: "secret", arguments: {} });
    const content = (seen as { content: { type: string; text?: string }[] }).content;
    console.log(`PROBE ${content[0]?.text ?? ""}`);
  } finally {
    await client.close();
  }
} finally {
  host.closeAll();
  // Windows releases a directory a killed child was using a moment later: retry the cleanup.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
