/**
 * Connections over REST (spec §7.1 `.../connections`, `/connect/callback/{provider}`,
 * `.../oauth-clients`, `GET /.well-known/oauth-client-metadata.json`; task 1.16).
 *
 * A token is written here and never read back: a connection goes out as its provider, the account
 * it speaks as, and a hint — never the secret. The test call doubles as proof it still works.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { AUTH_KINDS, CIMD_PATH, clientMetadata, lanesOf, webhookUrl } from "@perch/connect";
import { type ConnectionGrant, GRANT_SUBJECTS } from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import { API_VERSION, type AppEnv, type Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { botFor } from "../services/bots.ts";
import { getProject, projectRunnerLink } from "../services/projects.ts";
import { openPullRequest } from "../services/pull-requests.ts";
import { projectDeps } from "./projects.ts";
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
    lanes: z.array(z.enum(AUTH_KINDS)),
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
      /** The provider's MCP server, when this host runs its own (task 1.17). */
      mcp_url: z.url().max(2048).optional(),
    }),
    z.object({
      kind: z.literal("github_app"),
      provider: z.string().min(1).max(64),
      app_id: z.string().min(1).max(64),
      private_key: z.string().min(1).max(16_384),
      installation_id: z.string().min(1).max(64),
      owner_type: z.enum(["user", "workspace"]).default("user"),
      api_base: z.url().max(2048).optional(),
      /** The provider's MCP server, when this host runs its own (task 1.17). */
      mcp_url: z.url().max(2048).optional(),
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

const grantSchema = z
  .object({
    id: z.uuid(),
    subject_type: z.enum(GRANT_SUBJECTS),
    subject_id: z.uuid(),
    /** Null means every tool the connection exposes. */
    allowed_tools: z.array(z.string()).nullable(),
    /** Tools a person has to say yes to, every time (spec §3.5; task 3.6). Null is none. */
    requires_permission: z.array(z.string()).nullable(),
    channels: z.array(z.string()).nullable(),
    /** Whether it may use this connection only for the person it belongs to (spec §3.5). */
    obo: z.boolean(),
    created_at: z.string(),
  })
  .openapi("ConnectionGrant");

const grantsSchema = z.object({ grants: z.array(grantSchema) }).openapi("ConnectionGrants");

const grantBody = z
  .object({
    subject_type: z.enum(GRANT_SUBJECTS),
    subject_id: z.uuid(),
    allowed_tools: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
    requires_permission: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
    channels: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
    obo: z.boolean().optional(),
  })
  .openapi("GrantConnection");

const listGrantsRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/connections/{id}/grants",
  tags: ["connections"],
  summary: "Who may use this connection, and for what",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsIdParam },
  responses: {
    200: { description: "Grants", content: { "application/json": { schema: grantsSchema } } },
    ...errorResponses(403, 404),
  },
});

const grantRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/connections/{id}/grants",
  tags: ["connections"],
  summary: "Let a bot, an automation or a session use this connection",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: wsIdParam,
    body: { content: { "application/json": { schema: grantBody } } },
  },
  responses: {
    201: { description: "The grant", content: { "application/json": { schema: grantSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const revokeGrantRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/connections/{id}/grants/{grant}",
  tags: ["connections"],
  summary: "Take a grant away",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsIdParam.extend({ grant: z.uuid() }) },
  responses: { 204: { description: "Gone" }, ...errorResponses(403, 404) },
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

const startRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/connections/start",
  tags: ["connections"],
  summary: "Begin an OAuth authorization; answers the URL to send the person to",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: wsParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              provider: z.string().min(1).max(64),
              owner_type: z.enum(["user", "workspace"]).default("user"),
              scopes: z.array(z.string().min(1).max(200)).max(50).optional(),
              /**
               * Which lane to take (task 2.14). `mcp` discovers the provider's authorization server
               * from its MCP server; `oauth2` uses the endpoints the manifest names. Absent means
               * the best one this provider offers.
               */
              lane: z.enum(["mcp", "oauth2"]).optional(),
              /** A self-hosted instance of this provider's MCP server, when it is not the default. */
              mcp_url: z.url().max(2000).optional(),
            })
            .openapi("StartConnection"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Where to send the person, and the state the callback is checked against",
      content: {
        "application/json": {
          schema: z.object({
            url: z.string(),
            state: z.string(),
            /** How Perch came by the client id it used: pre_registered, cimd, or dcr. */
            lane: z.string().optional(),
          }),
        },
      },
    },
    ...errorResponses(403, 404, 422),
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/api/connect/callback/{provider}",
  tags: ["connections"],
  summary: "Where a provider sends someone back after they approve",
  request: {
    params: z.object({ provider: z.string().min(1).max(64) }),
    query: z.object({
      code: z.string().min(1).max(4096).optional(),
      state: z.string().min(1).max(512).optional(),
      error: z.string().max(200).optional(),
      error_description: z.string().max(1000).optional(),
    }),
  },
  responses: {
    302: { description: "Back to the workspace's Connections page, with the outcome" },
    ...errorResponses(422),
  },
});

const oauthClientBody = z
  .object({
    provider: z.string().min(1).max(64),
    client_id: z.string().min(1).max(200),
    client_secret: z.string().min(1).max(8192).optional(),
  })
  .openapi("RegisterOauthClient");

const oauthClientRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/oauth-clients",
  tags: ["connections"],
  summary: "Register your own app with a provider (the pre-registered lane of §3.5)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: wsParam,
    body: { content: { "application/json": { schema: oauthClientBody } } },
  },
  responses: {
    201: {
      description: "The app, with its redirect URI, and never its secret",
      content: {
        "application/json": {
          schema: z
            .object({ provider: z.string(), client_id: z.string(), redirect_uri: z.string() })
            .openapi("OauthClient"),
        },
      },
    },
    ...errorResponses(403, 404, 422),
  },
});

const pullRequestRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/pull-request",
  tags: ["connections"],
  summary: "Push the branch and open a pull request through a connection",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: z.object({ ws: z.uuid(), project: z.uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              connection_id: z.uuid(),
              title: z.string().min(1).max(300),
              body: z.string().max(60_000).optional(),
              head: z.string().min(1).max(200).optional(),
              base: z.string().min(1).max(200).optional(),
            })
            .openapi("OpenPullRequest"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "The pull request the provider opened",
      content: {
        "application/json": {
          schema: z
            .object({ number: z.number().int(), url: z.string(), branch: z.string() })
            .openapi("PullRequest"),
        },
      },
    },
    ...errorResponses(403, 404, 422, 502),
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
      ...(body.mcp_url ? { mcpUrl: body.mcp_url } : {}),
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

  app.openapi(startRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(
      c,
      deps,
      body.owner_type === "workspace" ? "connections.admin" : "connections.write",
      { type: "workspace", id: ws },
    );
    const input = {
      workspaceId: ws,
      userId: currentUser(c).id,
      provider: body.provider,
      ownerType: body.owner_type,
      ...(body.scopes ? { scopes: body.scopes } : {}),
      ...(body.mcp_url ? { mcpUrl: body.mcp_url } : {}),
    };
    // The MCP lane when it was asked for, or when it is the only one this provider offers.
    const lanes = lanesOf(connections.manifest(body.provider));
    const mcp =
      body.lane === "mcp" ||
      Boolean(body.mcp_url) ||
      (body.lane === undefined && !lanes.includes("oauth2"));
    return c.json(
      mcp ? await connections.startMcpOAuth(input) : await connections.startOAuth(input),
      200,
    );
  });

  app.openapi(callbackRoute, async (c) => {
    const { provider } = c.req.valid("param");
    const query = c.req.valid("query");
    const back = `${deps.env.publicUrl.replace(/\/+$/, "")}/connections`;
    // A provider that refuses, or a state Perch is not waiting for, is a message on the page the
    // person came from — never a stack trace on a URL they were redirected to.
    if (query.error || !query.code || !query.state) {
      const reason = query.error_description ?? query.error ?? "the provider sent nothing back";
      return c.redirect(`${back}?error=${encodeURIComponent(reason)}`, 302);
    }
    try {
      const row = await connections.finishOAuth({
        state: query.state,
        code: query.code,
        by: actorOf(c),
      });
      return c.redirect(`${back}?connected=${encodeURIComponent(row.provider)}`, 302);
    } catch (error) {
      const reason = error instanceof PerchError ? error.message : `could not connect ${provider}`;
      return c.redirect(`${back}?error=${encodeURIComponent(reason)}`, 302);
    }
  });

  app.openapi(oauthClientRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    // An app the whole workspace authorizes through belongs to the admins.
    await authorize(c, deps, "connections.admin", { type: "workspace", id: ws });
    const client = await connections.registerApp({
      workspaceId: ws,
      provider: body.provider,
      clientId: body.client_id,
      ...(body.client_secret ? { clientSecret: body.client_secret } : {}),
    });
    return c.json(
      {
        provider: client.provider,
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
      },
      201,
    );
  });

  app.openapi(pullRequestRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    // Opening a pull request is a write to the repository, so it is a project write here too.
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const user = currentUser(c);
    const project = await getProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const link = await projectRunnerLink(projectDeps(deps), project, user.id);
    return c.json(
      await openPullRequest(
        { connections },
        {
          project,
          link,
          userId: user.id,
          connectionId: body.connection_id,
          title: body.title,
          ...(body.body ? { body: body.body } : {}),
          ...(body.head ? { head: body.head } : {}),
          ...(body.base ? { base: body.base } : {}),
        },
      ),
      201,
    );
  });

  app.openapi(listGrantsRoute, async (c) => {
    const { ws, id } = c.req.valid("param");
    await authorize(c, deps, "connections.read", { type: "workspace", id: ws });
    const row = await connections.connectionFor(ws, currentUser(c).id, id);
    if (!row) throw PerchError.notFound("connection");
    return c.json({ grants: (await connections.grants(row.id)).map(grantBodyOf) }, 200);
  });

  app.openapi(grantRoute, async (c) => {
    const { ws, id } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "connections.write", { type: "workspace", id: ws });
    const user = currentUser(c);
    const row = await connections.connectionFor(ws, user.id, id);
    if (!row) throw PerchError.notFound("connection");
    // Handing out a shared connection is the workspace's decision, like disconnecting it (spec
    // §3.5 "workspace connections are admin-created with explicit grants").
    if (row.ownerType === "workspace") {
      await authorize(c, deps, "connections.admin", { type: "workspace", id: ws });
    }
    // A bot the whole workspace can talk to is what the on-behalf-of rule is about (spec §3.5).
    const shared =
      body.subject_type === "bot"
        ? (await botFor(deps.db.db, ws, body.subject_id)).visibility === "workspace"
        : body.subject_type === "automation";
    const grant = await connections.grant({
      connection: row,
      subjectType: body.subject_type,
      subjectId: body.subject_id,
      ...(body.allowed_tools === undefined ? {} : { allowedTools: body.allowed_tools }),
      ...(body.requires_permission === undefined
        ? {}
        : { requiresPermission: body.requires_permission }),
      ...(body.channels === undefined ? {} : { channels: body.channels }),
      ...(body.obo === undefined ? {} : { obo: body.obo }),
      grantedBy: user.id,
      shared,
      by: actorOf(c),
    });
    return c.json(grantBodyOf(grant), 201);
  });

  app.openapi(revokeGrantRoute, async (c) => {
    const { ws, id, grant } = c.req.valid("param");
    await authorize(c, deps, "connections.write", { type: "workspace", id: ws });
    const row = await connections.connectionFor(ws, currentUser(c).id, id);
    if (!row) throw PerchError.notFound("connection");
    if (row.ownerType === "workspace") {
      await authorize(c, deps, "connections.admin", { type: "workspace", id: ws });
    }
    const gone = await connections.revoke(row, grant, actorOf(c));
    if (!gone) throw PerchError.notFound("grant");
    return c.body(null, 204);
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

/** A grant as a caller sees it. */
function grantBodyOf(row: ConnectionGrant) {
  return {
    id: row.id,
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    allowed_tools: row.allowedTools ?? null,
    requires_permission: row.requiresPermission ?? null,
    channels: row.channels ?? null,
    obo: row.obo,
    created_at: row.createdAt.toISOString(),
  };
}
