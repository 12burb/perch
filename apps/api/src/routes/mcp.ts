/**
 * The MCP gateway over HTTP (spec §7.5 `/mcp/{connectionId}`; task 1.17).
 *
 * Perch is a Streamable HTTP MCP server here, and an MCP client upstream. A caller reaches it with
 * a token of Perch's own — a session's, an api token, or a browser session — and never with a
 * provider's credential; the provider's credential is attached on the upstream call inside
 * `McpGateway` and goes nowhere else (AGENTS.md §1.6).
 *
 * This route is outside the OpenAPI document on purpose: its contract is MCP's, not Perch's, and
 * describing JSON-RPC-over-POST as REST would describe it wrongly.
 */

import type { OpenAPIHono } from "@hono/zod-openapi";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Connection } from "@perch/db";
import type { ActorContext } from "../auth/authorize.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { verifyToolToken } from "../services/mcp.ts";

/** Who is calling, once their token has been read. */
type Caller = { workspaceId: string; userId: string; sessionId: string };

export function registerMcp(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.all("/mcp/:connectionId", async (c) => {
    const connectionId = c.req.param("connectionId");
    const caller = await callerOf(c.req.header("authorization"), deps);
    if (!caller) {
      // MCP clients expect the challenge, so they know to go and get a token.
      return c.json(
        { error: { code: "unauthorized", message: "a gateway token is required" } },
        401,
        {
          "www-authenticate": 'Bearer realm="perch"',
        },
      );
    }
    const connection = await deps.connections.connectionFor(
      caller.workspaceId,
      caller.userId,
      connectionId,
    );
    if (!connection) throw PerchError.notFound("connection");
    const allowList = await deps.mcp.allowListFor(connection, caller.sessionId);

    const by: ActorContext = {
      actor: { type: "user", id: caller.userId },
      meta: { requestId: c.get("requestId") },
    };
    const server = mcpServerFor(deps, connection, allowList, caller, by);
    // Stateless: every request stands alone, which is what a proxy in front of someone else's
    // server can honestly promise.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close().catch(() => undefined);
    }
  });
}

function mcpServerFor(
  deps: Deps,
  connection: Connection,
  allowList: string[] | null,
  caller: Caller,
  by: ActorContext,
): Server {
  const server = new Server(
    { name: `perch-${connection.provider}`, version: "1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await deps.mcp.tools(connection, allowList);
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        // The upstream's own schema, passed through: Perch does not get to reinterpret it.
        inputSchema: (tool.inputSchema ?? { type: "object" }) as { type: "object" },
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await deps.mcp.call({
      connection,
      allowList,
      tool: request.params.name,
      args: request.params.arguments ?? {},
      by,
      callerId: caller.userId,
    });
    return result as { content: { type: "text"; text: string }[] };
  });
  return server;
}

/** The bearer token a caller arrived with, if Perch minted it and it is still good. */
async function callerOf(header: string | undefined, deps: Deps): Promise<Caller | null> {
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const claims = await verifyToolToken(deps.env.sessionSecret, token);
  if (!claims) return null;
  return { workspaceId: claims.ws, userId: claims.user, sessionId: claims.session };
}
