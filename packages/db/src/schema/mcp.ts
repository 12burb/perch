/**
 * MCP servers (spec §6 mcp_servers, §7.5; task 1.17): the servers Perch can put in front of an
 * agent. One row per connection whose provider publishes an MCP URL, plus the stdio servers a
 * runner hosts locally, so a session's tool list can be assembled without asking every provider
 * on every turn.
 */
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { id, timestamps, timestamptz } from "../columns.ts";
import { connections } from "./connections.ts";
import { projects, runners } from "./projects.ts";
import { workspaces } from "./tenancy.ts";

/** http: a Streamable HTTP server Perch proxies; stdio: one a runner spawns (spec §7.5). */
export const MCP_TRANSPORTS = ["http", "stdio"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** What a stdio server is started with: `mcp.spawn {command, args}` (spec §7.6). */
export type McpCommand = { command: string; args: string[] };

/** A tool as the upstream described it, kept so a list can be answered without a round trip. */
export type CachedTool = {
  name: string;
  description?: string;
  /** The JSON Schema the upstream published for the tool's arguments. */
  inputSchema?: unknown;
};

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The connection whose token this server is reached with, when it is reached over HTTP. */
    connectionId: uuid("connection_id").references(() => connections.id, { onDelete: "cascade" }),
    /** The runner that hosts it, when it is a local stdio server and a particular runner's. */
    runnerId: uuid("runner_id").references(() => runners.id, { onDelete: "cascade" }),
    /**
     * The project a stdio server belongs to (task 3.24). §6 lists only `runner_id`, but which
     * runner a project is on is the api's to work out and changes with the day; what does not
     * change is which repository the server is part of, and that is where its command runs.
     */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url"),
    /** What to run, for a stdio server: the command and its arguments (spec §6 `command jsonb`). */
    command: jsonb("command").$type<McpCommand>(),
    transport: text("transport").$type<McpTransport>().notNull().default("http"),
    /** What the upstream last said it could do, so a tool list is cheap (spec §6 tool_cache). */
    toolCache: jsonb("tool_cache").$type<CachedTool[]>().notNull().default([]),
    lastSyncedAt: timestamptz("last_synced_at"),
    ...timestamps(),
  },
  (t) => [
    index("mcp_servers_workspace_idx").on(t.workspaceId),
    index("mcp_servers_connection_idx").on(t.connectionId),
    index("mcp_servers_project_idx").on(t.projectId),
    check("mcp_servers_transport_check", sql`${t.transport} in ('http', 'stdio')`),
  ],
);
export type McpServer = typeof mcpServers.$inferSelect;
