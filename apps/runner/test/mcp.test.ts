import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocal } from "@perch/connect";
import { McpHost } from "../src/mcp.ts";
import { runnerPolicy } from "../src/policy.ts";
import { projectDir } from "../src/projects.ts";
import { createStreamPair } from "../src/streams.ts";

/**
 * Task 3.24 (spec §7.6 "mcp.spawn {command, args} → stream token"): an MCP server that runs inside
 * the runner. The server is a real one — the official SDK's stdio transport, spawned as a process
 * — because what is under test is that MCP's framing and a runner's stream are the same shape.
 */

const WS = "0190f2d0-0000-7000-8000-000000000001";
const PROJECT = "0190f2d0-0000-7000-8000-0000000000d1";
const ctx = { workspace_id: WS, user_id: "0190f2d0-0000-7000-8000-0000000000aa", cap: "test" };
const server = join(import.meta.dir, "fixtures", "stdio-mcp.ts");

let root = "";
let host: McpHost;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "perch-mcp-host-"));
  mkdirSync(projectDir(root, WS, PROJECT), { recursive: true });
  host = new McpHost({ root, policy: runnerPolicy() });
});

afterAll(() => {
  host.closeAll();
  rmSync(root, { recursive: true, force: true });
});

/** Spawn one and hand the host the api's end of the stream, the way the api does. */
async function connect(project?: string) {
  const { stream_token } = host.spawn({
    ...ctx,
    command: process.execPath,
    args: [server],
    ...(project ? { project } : {}),
  });
  const pair = createStreamPair();
  expect(host.attachToken(stream_token, pair.a)).toBe(true);
  return await openLocal(pair.b);
}

describe("an MCP server inside the runner (task 3.24)", () => {
  test("it lists its tools and answers a call, over the stream", async () => {
    const client = await connect(PROJECT);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((one) => one.name)).toContain("echo");

      const said = await client.callTool({ name: "echo", arguments: { text: "from the runner" } });
      const content = (said as { content: { type: string; text?: string }[] }).content;
      expect(content[0]?.text).toContain("from the runner");
    } finally {
      await client.close();
    }
  }, 60_000);

  test("it runs in the project's directory when it is given one", async () => {
    const client = await connect(PROJECT);
    try {
      const said = await client.callTool({ name: "where", arguments: {} });
      const content = (said as { content: { type: string; text?: string }[] }).content;
      expect(content[0]?.text).toBe(projectDir(root, WS, PROJECT));
    } finally {
      await client.close();
    }
  }, 60_000);

  test("a project that is not on this runner is said out loud, not spawned", () => {
    expect(() =>
      host.spawn({
        ...ctx,
        command: process.execPath,
        args: [server],
        project: "0190f2d0-0000-7000-8000-0000000000ff",
      }),
    ).toThrow("not on this runner");
  });

  test("the policy decides what may be spawned, as it does for exec", () => {
    expect(() => host.spawn({ ...ctx, command: "rm", args: ["-rf", "/"] })).toThrow();
  });

  test("a stream nobody claims takes the process with it", async () => {
    const { stream_token } = host.spawn({ ...ctx, command: process.execPath, args: [server] });
    const pair = createStreamPair();
    expect(host.attachToken(stream_token, pair.a)).toBe(true);
    const client = await openLocal(pair.b);
    await client.close();
    // Closing the api's end ends the server: a process nobody is talking to is a process to stop.
    await Bun.sleep(100);
    expect(pair.a.closed).toBe(true);
  }, 60_000);
});
