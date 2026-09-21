/**
 * The MCP gateway over HTTP (spec §7.5 `/mcp/{connectionId}`; task 1.17).
 *
 * Perch is a Streamable HTTP MCP server here, and an MCP client upstream. A caller reaches it with
 * a token of Perch's own — a session's, an api token, or a browser session — and never with a
 * provider's credential; the provider's credential is attached on the upstream call inside
 * `McpGateway` and goes nowhere else (AGENTS.md §1.6).
 *
 * `/mcp/perch` is the other half (spec §7.5 "Perch's own MCP server"; task 3.12): there Perch is
 * the provider rather than the proxy, and the caller is an agent outside holding an api token.
 *
 * These routes are outside the OpenAPI document on purpose: their contract is MCP's, not Perch's,
 * and describing JSON-RPC-over-POST as REST would describe it wrongly.
 */

import { type OpenAPIHono, z } from "@hono/zod-openapi";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Connection, McpServer } from "@perch/db";
import type { Context } from "hono";
import type { ActorContext } from "../auth/authorize.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { getMcpServer } from "../repos/mcp-servers.ts";
import { findMembership } from "../repos/workspaces.ts";
import { verifyToolToken } from "../services/mcp.ts";
import type { PerchCaller } from "../services/perch-mcp.ts";
import { resolveApiToken } from "../services/tokens.ts";

/** Who is calling, once their token has been read. */
type Caller = { workspaceId: string; userId: string; sessionId: string };

/** The challenge an MCP client needs in order to know it should go and get a token. */
function unauthorized(c: Context<AppEnv>, message: string) {
  return c.json({ error: { code: "unauthorized", message } }, 401, {
    "www-authenticate": 'Bearer realm="perch"',
  });
}

export function registerMcp(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  // Perch's own server. It is registered before `/mcp/:connectionId` because `perch` is not a
  // connection id and never will be — an id is a uuid.
  app.all("/mcp/perch", async (c) => {
    const caller = await apiTokenCaller(c.req.header("authorization"), deps);
    if (!caller) return unauthorized(c, "an api token is required");
    const by: ActorContext = {
      actor: { type: "user", id: caller.userId },
      meta: { requestId: c.get("requestId") },
    };
    const server = perchServerFor(deps, caller, by);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  app.all("/mcp/:connectionId", async (c) => {
    const connectionId = c.req.param("connectionId");
    const header = c.req.header("authorization");
    // A gateway token is a session's; an api token is a person's. The first is how an agent Perch
    // started reaches a connection; the second is how anything else reaches a server that has no
    // credential to hand out (task 3.24).
    const outside = await apiTokenCaller(header, deps);
    const caller: Caller | null =
      (await callerOf(header, deps)) ??
      (outside?.workspaceId
        ? { workspaceId: outside.workspaceId, userId: outside.userId, sessionId: "" }
        : null);
    // MCP clients expect the challenge, so they know to go and get a token.
    if (!caller) return unauthorized(c, "a gateway token is required");
    // Neither a connection nor a server has an id of any other shape, so anything else is not
    // found rather than a question for the database (which would refuse the value with a 500).
    if (!z.uuid().safeParse(connectionId).success) throw PerchError.notFound("connection");
    // A runner-local server is reached at the same shape and answers the same protocol; which of
    // the two an id names is Perch's business, not the caller's (spec §3.5; task 3.24).
    const local = await getMcpServer(deps.db.db, connectionId);
    if (local && local.workspaceId === caller.workspaceId) {
      const by: ActorContext = {
        actor: { type: "user", id: caller.userId },
        meta: { requestId: c.get("requestId") },
      };
      const server = localServerFor(deps, local, caller, by);
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      try {
        return await transport.handleRequest(c.req.raw);
      } finally {
        await server.close().catch(() => undefined);
      }
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

/**
 * A server the runner hosts, as an MCP server of Perch's (task 3.24). There is no allow-list here
 * because there is no grant: a local server carries no credential of anybody's, so what gates it
 * is the workspace it belongs to and the runner's policy on its command (ADR-0142).
 */
function localServerFor(deps: Deps, row: McpServer, caller: Caller, by: ActorContext): Server {
  const server = new Server(
    { name: `perch-${row.name}`, version: "1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await deps.localMcp.tools(row, null, caller.userId);
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: (tool.inputSchema ?? { type: "object" }) as { type: "object" },
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await deps.localMcp.call({
      server: row,
      allowList: null,
      tool: request.params.name,
      args: request.params.arguments ?? {},
      by,
      callerId: caller.userId,
      userId: caller.userId,
    });
    return result as { content: { type: "text"; text: string }[] };
  });
  return server;
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

/**
 * Perch's own tools, filtered to what this token may do. A tool the caller has no scope for is
 * never listed, so an agent plans with the doors it actually has (spec §7.5).
 */
function perchServerFor(deps: Deps, caller: PerchCaller, by: ActorContext): Server {
  const server = new Server({ name: "perch", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: deps.perchMcp.tools(caller).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await deps.perchMcp.call(
        caller,
        request.params.name,
        request.params.arguments ?? {},
        by,
      );
    } catch (error) {
      // MCP's own convention: a tool that would not run says so in its result, so the agent can
      // read the reason and try something else. A JSON-RPC error would only tell it the call
      // broke. Perch's errors are already written for a person (spec §7.8), so they say enough.
      const message = error instanceof PerchError ? error.message : "that did not work";
      if (!(error instanceof PerchError)) {
        deps.log.error({ err: error, tool: request.params.name }, "a perch mcp tool failed");
      }
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  });
  return server;
}

/** The api token a caller arrived with (spec §7.1: "Bearer api token (SDKs, MCP server)"). */
async function apiTokenCaller(header: string | undefined, deps: Deps): Promise<PerchCaller | null> {
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith("pat_")) return null;
  const resolved = await resolveApiToken(deps.db.db, token);
  // The workspace on a token was the caller's choice when they made it (routes/me.ts checks it
  // then); membership is checked again here because this is where the token stands in for the
  // path, and somebody who has left a workspace keeps their token.
  if (
    resolved?.workspaceId &&
    !(await findMembership(deps.db.db, resolved.workspaceId, resolved.userId))
  ) {
    return null;
  }
  if (!resolved) return null;
  return { userId: resolved.userId, workspaceId: resolved.workspaceId, scopes: resolved.scopes };
}

/** The bearer token a caller arrived with, if Perch minted it and it is still good. */
async function callerOf(header: string | undefined, deps: Deps): Promise<Caller | null> {
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const claims = await verifyToolToken(deps.env.sessionSecret, token);
  if (!claims) return null;
  return { workspaceId: claims.ws, userId: claims.user, sessionId: claims.session };
}
