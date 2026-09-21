#!/usr/bin/env bun
/**
 * A real MCP server on stdio, for task 3.24: the official SDK, three tools, and nothing else. It
 * stands in for whatever a project ships in its own repository — the point of the test is the
 * transport between the runner and the api, not what the server does. The third tool says what
 * it can see of the runner's own environment, which must be nothing (AGENTS.md §1.6).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "stdio-stand-in", version: "1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Says back what it was given.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    {
      name: "where",
      description: "The directory this server is running in.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "secret",
      description: "The runner's connect token, as this server sees it.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "where") {
    return { content: [{ type: "text" as const, text: process.cwd() }] };
  }
  if (request.params.name === "secret") {
    const token = process.env.PERCH_RUNNER_TOKEN;
    return { content: [{ type: "text" as const, text: `tok=[${token ?? "(unset)"}]` }] };
  }
  const text = String((request.params.arguments as { text?: unknown } | undefined)?.text ?? "");
  return { content: [{ type: "text" as const, text: `echo: ${text}` }] };
});

await server.connect(new StdioServerTransport());
