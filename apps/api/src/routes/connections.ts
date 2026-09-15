/**
 * Connections over REST (spec §7.1 `.../connections`, `/connect/callback/{provider}`,
 * `.../oauth-clients`, `GET /.well-known/oauth-client-metadata.json`; task 1.16).
 *
 * A token is written here and never read back: a connection goes out as its provider, the account
 * it speaks as, and a hint — never the secret. The test call doubles as proof it still works.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { CIMD_PATH, clientMetadata, lanesOf, webhookUrl } from "@perch/connect";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import { API_VERSION, type AppEnv, type Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const wsParam = z.object({ ws: z.uuid() });
const wsIdParam = z.object({ ws: z.uuid(), id: z.uuid() });

const providerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    summary: z.string().optional(),
    docs_url: z.string().optional(),
    /** The lanes this provider offers, strongest identity first (spec §3.5). */
    lanes: z.array(z.enum(["github_app", "oauth2", "token"])),
    api_base: z.string(),
    token_prefix: z.array(z.string()),
    /** Prefilled for the wizard, so nobody has to work out their own public URL. */
    callback_url: z.string(),
    webhook_url: z.string(),
  })
  .openapi("ConnectionProvider");

const connectionSchema = z
  .object({
    id: z.uuid(),
    provider: z.string(),
    provider_name: z.string(),
    kind: z.enum(["mcp_oauth", "oauth2", "github_app", "token"]),
    owner_type: z.enum(["user", "workspace"]),
    owner_id: z.uuid(),
    scopes: z.array(z.string()),
    status: z.string(),
    /** Who the provider says this connection speaks as. */
    account: z.string().nullable(),
    /** The first two and last four characters of a pasted token, never the token. */
    hint: z.string().nullable(),
    expires_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Connection");

const providersRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/connection-providers",
  tags: ["connections"],
  summary: "The services this instance can connect to, with its callback and webhook URLs",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "Every connector this instance ships",
      content: {
        "application/json": { schema: z.object({ providers: z.array(providerSchema) }) },
      },
    },
    ...errorResponses(403, 404),
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/connections",
  tags: ["connections"],
  summary: "The connections you may use here",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "The workspace's shared connections and your own, never their secrets",
      content: {
        "application/json": { schema: z.object({ connections: z.array(connectionSchema) }) },
      },
    },
    ...errorResponses(403, 404),
  },
});

const createBody = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("token"),
      provider: z.string().min(1).max(64),
      token: z.string().min(1).max(8192),
      owner_type: z.enum(["user", "workspace"]).default("user"),
      api_base: z.url().max(2048).optional(),
    }),
    z.object({
      kind: z.literal("github_app"),
      provider: z.string().min(1).max(64),
      app_id: z.string().min(1).max(64),
      private_key: z.string().min(1).max(16_384),
      installation_id: z.string().min(1).max(64),
      owner_type: z.enum(["user", "workspace"]).default("user"),
      api_base: z.url().max(2048).optional(),
    }),
  ])
  .openapi("CreateConnection");

const createRouteDef = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/connections",
  tags: ["connections"],
  summary: "Connect a service with a pasted token or an app installation",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam, body: { content: { "application/json": { schema: createBody } } } },
  responses: {
    201: {
      description: "The connection, with a hint instead of the secret",
      content: { "application/json": { schema: connectionSchema } },
    },
    ...errorResponses(403, 404, 422, 502),
  },
});

const testRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/connections/{id}/test",
  tags: ["connections"],
  summary: "Ask the provider whether this connection still works",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsIdParam },
  responses: {
    200: {
      description: "Who it speaks as, and what it may do",
      content: {
        "application/json": {
          schema: z.object({ account: z.string().nullable(), scopes: z.array(z.string()) }),
        },
      },
    },
    ...errorResponses(403, 404, 502),
  },
});

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/connections/{id}",
  tags: ["connections"],
  summary: "Disconnect a service",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsIdParam },
  responses: { 204: { description: "Gone" }, ...errorResponses(403, 404) },
});

const metadataRoute = createRoute({
  method: "get",
  path: CIMD_PATH,
  tags: ["connections"],
  summary: "This instance as an OAuth client (the CIMD document of spec §3.5)",
  responses: {
    200: {
      description: "Client metadata whose URL is also the client_id it declares",
      content: {
        "application/json": {
          schema: z
            .object({
              client_id: z.string(),
              client_name: z.string(),
              client_uri: z.string(),
              redirect_uris: z.array(z.string()),
              grant_types: z.array(z.string()),
              response_types: z.array(z.string()),
              token_endpoint_auth_method: z.string(),
              software_id: z.string(),
              software_version: z.string(),
            })
            .openapi("ClientMetadata"),
        },
      },
    },
  },
});

export function registerConnections(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const connections = deps.connections;

  app.openapi(metadataRoute, (c) =>
    c.json(
      clientMetadata({
        publicUrl: deps.env.publicUrl,
        version: API_VERSION,
        providers: connections.providers().map((manifest) => manifest.id),
      }),
      200,
    ),
  );

  app.openapi(providersRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "connections.read", { type: "workspace", id: ws });
    return c.json(
      {
        providers: connections.providers().map((manifest) => ({
          id: manifest.id,
          name: manifest.name,
          ...(manifest.summary ? { summary: manifest.summary } : {}),
          ...(manifest.docs_url ? { docs_url: manifest.docs_url } : {}),
          lanes: lanesOf(manifest),
          api_base: manifest.api_base,
          token_prefix: manifest.token_prefix,
          callback_url: connections.callback(manifest.id),
          webhook_url: webhookUrl(deps.env.publicUrl, manifest.id, ws),
        })),
      },
      200,
    );
  });

  app.openapi(listRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "connections.read", { type: "workspace", id: ws });
    const rows = await connections.connections(ws, currentUser(c).id);
    return c.json({ connections: rows.map((row) => toConnection(connections.view(row))) }, 200);
  });

  app.openapi(createRouteDef, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    // Your own account is yours to connect; one the whole workspace acts through is an admin's.
    await authorize(
      c,
      deps,
      body.owner_type === "workspace" ? "connections.admin" : "connections.write",
      { type: "workspace", id: ws },
    );
    const common = {
      workspaceId: ws,
      userId: currentUser(c).id,
      provider: body.provider,
      ownerType: body.owner_type,
      ...(body.api_base ? { apiBase: body.api_base } : {}),
      by: actorOf(c),
    };
    const row =
      body.kind === "token"
        ? await connections.addToken({ ...common, token: body.token })
        : await connections.addGitHubApp({
            ...common,
            appId: body.app_id,
            privateKey: body.private_key,
            installationId: body.installation_id,
          });
    return c.json(toConnection(connections.view(row)), 201);
  });

  app.openapi(testRoute, async (c) => {
    const { ws, id } = c.req.valid("param");
    await authorize(c, deps, "connections.read", { type: "workspace", id: ws });
    const row = await connections.connectionFor(ws, currentUser(c).id, id);
    if (!row) throw PerchError.notFound("connection");
    return c.json(await connections.test(row), 200);
  });

  app.openapi(deleteRouteDef, async (c) => {
    const { ws, id } = c.req.valid("param");
    await authorize(c, deps, "connections.write", { type: "workspace", id: ws });
    const row = await connections.connectionFor(ws, currentUser(c).id, id);
    if (!row) throw PerchError.notFound("connection");
    // A shared connection is the workspace's, so disconnecting it is an admin's call.
    if (row.ownerType === "workspace") {
      await authorize(c, deps, "connections.admin", { type: "workspace", id: ws });
    }
    await connections.remove(row, actorOf(c));
    return c.body(null, 204);
  });
}

function toConnection(view: ReturnType<Deps["connections"]["view"]>) {
  return {
    id: view.id,
    provider: view.provider,
    provider_name: view.providerName,
    kind: view.kind,
    owner_type: view.ownerType,
    owner_id: view.ownerId,
    scopes: view.scopes,
    status: view.status,
    account: view.account,
    hint: view.hint,
    expires_at: view.expiresAt,
    created_at: view.createdAt,
  };
}
