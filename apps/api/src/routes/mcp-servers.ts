/**
 * The MCP servers a runner hosts (spec §3.5 "runner-local stdio MCP servers are exposed through
 * the same shape", §6 `mcp_servers`; task 3.24).
 *
 * A row here says: this project ships tools of its own, and this is the command that starts them.
 * What it does not say is anything secret — there is no token to keep, because the server runs
 * where the project does and talks to nobody but the runner it is inside.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { authorize } from "../auth/authorize.ts";
import { requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import {
  deleteMcpServer,
  getMcpServer,
  insertMcpServer,
  listMcpServers,
} from "../repos/mcp-servers.ts";
import { findProject } from "../repos/projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const wsParam = z.object({ ws: z.uuid() });
const oneParam = z.object({ ws: z.uuid(), id: z.uuid() });

const serverSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    project_id: z.uuid().nullable(),
    transport: z.enum(["http", "stdio"]),
    command: z.object({ command: z.string(), args: z.array(z.string()) }).nullable(),
    /** What it last said it could do, so a list is something even when the runner is asleep. */
    tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
    url: z.string().nullable(),
    last_synced_at: z.string().nullable(),
  })
  .openapi("McpServer");

const createBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    project_id: z.uuid(),
    command: z.string().trim().min(1).max(500),
    args: z.array(z.string().max(500)).max(50).optional(),
  })
  .openapi("CreateMcpServer");

const listRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/mcp-servers",
  tags: ["connections"],
  summary: "The MCP servers this workspace's runners host",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam, query: z.object({ project: z.uuid().optional() }) },
  responses: {
    200: {
      description: "The servers",
      content: {
        "application/json": {
          schema: z.object({ servers: z.array(serverSchema) }).openapi("McpServers"),
        },
      },
    },
    ...errorResponses(403, 404),
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/mcp-servers",
  tags: ["connections"],
  summary: "Write down a server a project's runner can start",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam, body: { content: { "application/json": { schema: createBody } } } },
  responses: {
    201: { description: "The server", content: { "application/json": { schema: serverSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const removeRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/mcp-servers/{id}",
  tags: ["connections"],
  summary: "Forget one",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: oneParam },
  responses: {
    200: {
      description: "Gone",
      content: { "application/json": { schema: z.object({ removed: z.boolean() }) } },
    },
    ...errorResponses(403, 404),
  },
});

export function registerMcpServers(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const view = (row: Awaited<ReturnType<typeof getMcpServer>>) => {
    if (!row) throw PerchError.notFound("mcp server");
    return {
      id: row.id,
      name: row.name,
      project_id: row.projectId,
      transport: row.transport,
      command: row.command,
      tools: row.toolCache.map((one) => ({
        name: one.name,
        ...(one.description ? { description: one.description } : {}),
      })),
      url: row.url,
      last_synced_at: row.lastSyncedAt?.toISOString() ?? null,
    };
  };

  app.openapi(listRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const { project } = c.req.valid("query");
    await authorize(c, deps, "connections.read", { type: "workspace", id: ws });
    const rows = await listMcpServers(deps.db.db, ws, project);
    return c.json({ servers: rows.map(view) }, 200);
  });

  app.openapi(createRouteDef, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    // Writing one is an admin's act: the command runs on the workspace's own machines.
    await authorize(c, deps, "connections.admin", { type: "workspace", id: ws });
    const project = await findProject(deps.db.db, ws, body.project_id);
    if (!project) throw PerchError.notFound("project");
    const row = await insertMcpServer(deps.db.db, {
      workspaceId: ws,
      projectId: project.id,
      name: body.name,
      command: { command: body.command, args: body.args ?? [] },
    });
    return c.json(view(row), 201);
  });

  app.openapi(removeRoute, async (c) => {
    const { ws, id } = c.req.valid("param");
    await authorize(c, deps, "connections.admin", { type: "workspace", id: ws });
    const row = await getMcpServer(deps.db.db, id);
    if (!row || row.workspaceId !== ws) throw PerchError.notFound("mcp server");
    return c.json({ removed: await deleteMcpServer(deps.db.db, id) }, 200);
  });
}
