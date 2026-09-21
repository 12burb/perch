/**
 * The Deploy button and the database panel over REST (spec §5.5, §7.1; task 2.15).
 *
 * A deploy is a POST that answers with where the build got to and the message it was announced in;
 * a refresh asks the provider again and rewrites that message. The database panel is two reads that
 * go through the MCP gateway, so the connection's token stays where it always is.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { channelFor } from "../services/channels.ts";
import { getProject } from "../services/projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });
const connectionParam = z.object({ ws: z.uuid(), id: z.uuid() });

const deploymentSchema = z
  .object({
    id: z.string(),
    state: z.enum(["queued", "building", "ready", "error", "canceled"]),
    target: z.enum(["preview", "production"]),
    url: z.string().nullable(),
    inspector_url: z.string().nullable(),
    /** The message the card lives in, which is what a refresh addresses. */
    message_id: z.uuid(),
  })
  .openapi("Deployment");

const startBody = z
  .object({
    connection_id: z.uuid(),
    /** Where the card goes; a deploy nobody can see is not what §5.5 asks for. */
    channel_id: z.uuid(),
    thread_root_id: z.uuid().optional(),
    target: z.enum(["preview", "production"]).default("preview"),
    /** The branch to build; the project's current one when it is not said. */
    branch: z.string().min(1).max(200).optional(),
  })
  .openapi("StartDeploy");

const refreshBody = z
  .object({ connection_id: z.uuid(), message_id: z.uuid() })
  .openapi("RefreshDeploy");

const startRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/deploys",
  tags: ["projects"],
  summary: "Deploy this project through a connection, and post the card",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: { content: { "application/json": { schema: startBody } } },
  },
  responses: {
    201: {
      description: "The deployment and where it was announced",
      content: { "application/json": { schema: deploymentSchema } },
    },
    ...errorResponses(403, 404, 422, 502),
  },
});

const refreshRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/deploys/refresh",
  tags: ["projects"],
  summary: "Ask the provider where a deploy got to, and rewrite its card",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: { content: { "application/json": { schema: refreshBody } } },
  },
  responses: {
    200: {
      description: "Where it got to",
      content: { "application/json": { schema: deploymentSchema } },
    },
    ...errorResponses(403, 404, 422, 502),
  },
});

const columnSchema = z
  .object({ name: z.string(), type: z.string(), nullable: z.boolean() })
  .openapi("DbColumn");

const tablesSchema = z
  .object({
    tables: z.array(
      z.object({
        schema: z.string(),
        name: z.string(),
        rows: z.number().nullable(),
        columns: z.array(columnSchema),
      }),
    ),
  })
  .openapi("DbTables");

const queryBody = z.object({ sql: z.string().min(1).max(20_000) }).openapi("DbQuery");
const querySchema = z
  .object({ columns: z.array(z.string()), rows: z.array(z.record(z.string(), z.unknown())) })
  .openapi("DbRows");

const tablesRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/connections/{id}/db/tables",
  tags: ["connections"],
  summary: "The tables this connection's database has",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: connectionParam,
    query: z.object({ schemas: z.string().optional() }),
  },
  responses: {
    200: { description: "Tables", content: { "application/json": { schema: tablesSchema } } },
    ...errorResponses(403, 404, 422, 502),
  },
});

const queryRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/connections/{id}/db/query",
  tags: ["connections"],
  summary: "Run one read-only statement",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: connectionParam,
    body: { content: { "application/json": { schema: queryBody } } },
  },
  responses: {
    200: { description: "Rows", content: { "application/json": { schema: querySchema } } },
    ...errorResponses(403, 404, 422, 451, 502),
  },
});

export function registerDeploys(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const connectionOf = async (ws: string, userId: string, id: string) => {
    const row = await deps.connections.connectionFor(ws, userId, id);
    if (!row) throw PerchError.notFound("connection");
    return row;
  };

  app.openapi(startRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    // Deploying is a write to the outside world on this project's behalf.
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const user = currentUser(c);
    const project = await getProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    // The caller's own view of the channel (spec §2.1), as for a message.
    const channel = await channelFor(deps, ws, body.channel_id, user.id);
    const connection = await connectionOf(ws, user.id, body.connection_id);
    const { deployment, message } = await deps.deploys.start({
      project,
      connection,
      channel,
      userId: user.id,
      target: body.target,
      ...(body.branch ? { branch: body.branch } : {}),
      ...(body.thread_root_id ? { threadRootId: body.thread_root_id } : {}),
      by: actorOf(c),
    });
    return c.json(view(deployment, message.id), 201);
  });

  app.openapi(refreshRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "projects.read", { type: "workspace", id: ws });
    const user = currentUser(c);
    const project = await getProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const connection = await connectionOf(ws, user.id, body.connection_id);
    const deployment = await deps.deploys.refresh({
      connection,
      messageId: body.message_id,
      by: actorOf(c),
    });
    return c.json(view(deployment, body.message_id), 200);
  });

  app.openapi(tablesRoute, async (c) => {
    const { ws, id } = c.req.valid("param");
    const { schemas } = c.req.valid("query");
    await authorize(c, deps, "connections.read", { type: "workspace", id: ws });
    const user = currentUser(c);
    const connection = await connectionOf(ws, user.id, id);
    const tables = await deps.dbBrowser.tables({
      connection,
      userId: user.id,
      ...(schemas
        ? {
            schemas: schemas
              .split(",")
              .map((one) => one.trim())
              .filter(Boolean),
          }
        : {}),
      by: actorOf(c),
    });
    return c.json({ tables }, 200);
  });

  app.openapi(queryRoute, async (c) => {
    const { ws, id } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "connections.read", { type: "workspace", id: ws });
    const user = currentUser(c);
    const connection = await connectionOf(ws, user.id, id);
    const result = await deps.dbBrowser.query({
      connection,
      userId: user.id,
      sql: body.sql,
      by: actorOf(c),
    });
    return c.json(result, 200);
  });
}

function view(
  deployment: {
    id: string;
    state: string;
    target: string;
    url: string | null;
    inspectorUrl: string | null;
  },
  messageId: string,
) {
  return {
    id: deployment.id,
    state: deployment.state as "queued" | "building" | "ready" | "error" | "canceled",
    target: deployment.target as "preview" | "production",
    url: deployment.url,
    inspector_url: deployment.inspectorUrl,
    message_id: messageId,
  };
}
