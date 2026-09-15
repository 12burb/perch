/**
 * Brains over REST (spec §7.1 `.../credentials`, `.../model-profiles`, `.../models`; task 1.15).
 *
 * A secret is written here and never read back: a credential goes out as its provider, label, and
 * a hint, never as the key. The models list doubles as the test button — a provider that answers
 * with its catalog is a provider that took the credential.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const wsParam = z.object({ ws: z.uuid() });
const wsIdParam = z.object({ ws: z.uuid(), id: z.uuid() });

const providerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["api_key", "endpoint"]),
    base_url: z.string(),
    lists: z.boolean(),
    local: z.boolean().optional(),
  })
  .openapi("Provider");

const modelSchema = z
  .object({ id: z.string(), name: z.string().optional(), owned_by: z.string().optional() })
  .openapi("CatalogModel");

const credentialSchema = z
  .object({
    id: z.uuid(),
    provider: z.string(),
    provider_name: z.string(),
    kind: z.enum(["api_key", "endpoint", "oauth_ref"]),
    scope: z.enum(["user", "workspace"]),
    label: z.string(),
    base_url: z.string().nullable(),
    status: z.string(),
    owner_id: z.uuid(),
    /** The first two and last four characters of a key, never the key. */
    hint: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Credential");

const profileSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    provider: z.string(),
    model_id: z.string(),
    credential_id: z.uuid().nullable(),
    default_for: z.enum(["chat", "code"]).nullable(),
    created_at: z.string(),
  })
  .openapi("ModelProfile");

const providersRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/providers",
  tags: ["brains"],
  summary: "The providers a brain can run on, and a local Ollama if one is answering",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "The provider catalog and what was detected on this machine",
      content: {
        "application/json": {
          schema: z.object({
            providers: z.array(providerSchema),
            ollama: z.object({ base_url: z.string(), models: z.array(modelSchema) }).nullable(),
          }),
        },
      },
    },
    ...errorResponses(403, 404),
  },
});

const listCredentialsRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/credentials",
  tags: ["brains"],
  summary: "The credentials you may use here",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "The workspace's shared credentials and your own, never their secrets",
      content: {
        "application/json": { schema: z.object({ credentials: z.array(credentialSchema) }) },
      },
    },
    ...errorResponses(403, 404),
  },
});

const addCredentialRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/credentials",
  tags: ["brains"],
  summary: "Add an API key or an OpenAI-compatible endpoint",
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
              kind: z.enum(["api_key", "endpoint"]).default("api_key"),
              scope: z.enum(["user", "workspace"]).default("user"),
              label: z.string().min(1).max(120),
              secret: z.string().min(1).max(8192).optional(),
              base_url: z.string().url().max(2048).optional(),
            })
            .openapi("AddCredential"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "The credential, with a hint instead of the secret",
      content: { "application/json": { schema: credentialSchema } },
    },
    ...errorResponses(403, 404, 422),
  },
});

const deleteCredentialRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/credentials/{id}",
  tags: ["brains"],
  summary: "Remove a credential",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsIdParam },
  responses: {
    200: {
      description: "Gone, and the profiles that pointed at it",
      content: { "application/json": { schema: z.object({ profiles: z.array(z.string()) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const modelsRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/models",
  tags: ["brains"],
  summary: "What a credential can reach, asked of the provider",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam, query: z.object({ credential: z.uuid() }) },
  responses: {
    200: {
      description: "The provider's own model list",
      content: { "application/json": { schema: z.object({ models: z.array(modelSchema) }) } },
    },
    ...errorResponses(403, 404, 502),
  },
});

const listProfilesRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/model-profiles",
  tags: ["brains"],
  summary: "The workspace's brains",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "Model profiles, by name",
      content: { "application/json": { schema: z.object({ profiles: z.array(profileSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const addProfileRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/model-profiles",
  tags: ["brains"],
  summary: "Name a model to run on",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: wsParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              name: z.string().min(1).max(120),
              provider: z.string().min(1).max(64),
              model_id: z.string().min(1).max(200),
              credential_id: z.uuid().optional(),
              default_for: z.enum(["chat", "code"]).optional(),
            })
            .openapi("AddModelProfile"),
        },
      },
    },
  },
  responses: {
    201: { description: "The profile", content: { "application/json": { schema: profileSchema } } },
    ...errorResponses(403, 404, 409, 422),
  },
});

const defaultProfileRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/model-profiles/{id}/default",
  tags: ["brains"],
  summary: "Make this the workspace's default brain for chat or code",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: wsIdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({ for: z.enum(["chat", "code"]) }).openapi("MakeDefaultProfile"),
        },
      },
    },
  },
  responses: {
    200: { description: "The profile", content: { "application/json": { schema: profileSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const deleteProfileRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/model-profiles/{id}",
  tags: ["brains"],
  summary: "Remove a brain",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsIdParam },
  responses: { 204: { description: "Gone" }, ...errorResponses(403, 404) },
});

export function registerBrains(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const brains = deps.brains;

  app.openapi(providersRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "brains.read", { type: "workspace", id: ws });
    const { providers, ollama } = await brains.providers();
    return c.json(
      {
        providers: providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          kind: provider.kind,
          base_url: provider.baseUrl,
          lists: provider.lists,
          ...(provider.local ? { local: true } : {}),
        })),
        ollama: ollama ? { base_url: ollama.baseUrl, models: ollama.models } : null,
      },
      200,
    );
  });

  app.openapi(listCredentialsRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "brains.read", { type: "workspace", id: ws });
    const rows = await brains.credentials(ws, currentUser(c).id);
    return c.json({ credentials: rows.map((row) => toCredential(brains.view(row))) }, 200);
  });

  app.openapi(addCredentialRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    // Your own key is yours to add; one the whole workspace runs on belongs to the admins.
    await authorize(c, deps, body.scope === "workspace" ? "brains.admin" : "brains.write", {
      type: "workspace",
      id: ws,
    });
    const row = await brains.addCredential({
      workspaceId: ws,
      userId: currentUser(c).id,
      provider: body.provider,
      kind: body.kind,
      scope: body.scope,
      label: body.label,
      ...(body.secret ? { secret: body.secret } : {}),
      ...(body.base_url ? { baseUrl: body.base_url } : {}),
      by: actorOf(c),
    });
    return c.json(toCredential(brains.view(row)), 201);
  });

  app.openapi(deleteCredentialRoute, async (c) => {
    const { ws, id } = c.req.valid("param");
    await authorize(c, deps, "brains.write", { type: "workspace", id: ws });
    const row = await brains.credentialFor(ws, currentUser(c).id, id);
    if (!row) throw PerchError.notFound("credential");
    // A shared credential is the workspace's, so removing it is an admin's call.
    if (row.scope === "workspace") {
      await authorize(c, deps, "brains.admin", { type: "workspace", id: ws });
    }
    return c.json(await brains.removeCredential(row, actorOf(c)), 200);
  });

  app.openapi(modelsRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const { credential } = c.req.valid("query");
    await authorize(c, deps, "brains.read", { type: "workspace", id: ws });
    const row = await brains.credentialFor(ws, currentUser(c).id, credential);
    if (!row) throw PerchError.notFound("credential");
    const models = await brains.models(row);
    return c.json(
      {
        models: models.map((model) => ({
          id: model.id,
          ...(model.name ? { name: model.name } : {}),
          ...(model.ownedBy ? { owned_by: model.ownedBy } : {}),
        })),
      },
      200,
    );
  });

  app.openapi(listProfilesRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "brains.read", { type: "workspace", id: ws });
    const rows = await brains.profiles(ws);
    return c.json({ profiles: rows.map(toProfile) }, 200);
  });

  app.openapi(addProfileRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "brains.admin", { type: "workspace", id: ws });
    const row = await brains.addProfile({
      workspaceId: ws,
      userId: currentUser(c).id,
      name: body.name,
      provider: body.provider,
      modelId: body.model_id,
      ...(body.credential_id ? { credentialId: body.credential_id } : {}),
      ...(body.default_for ? { defaultFor: body.default_for } : {}),
      by: actorOf(c),
    });
    return c.json(toProfile(row), 201);
  });

  app.openapi(defaultProfileRoute, async (c) => {
    const { ws, id } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "brains.admin", { type: "workspace", id: ws });
    const row = await brains.setDefault(ws, id, body.for);
    if (!row) throw PerchError.notFound("model profile");
    return c.json(toProfile(row), 200);
  });

  app.openapi(deleteProfileRoute, async (c) => {
    const { ws, id } = c.req.valid("param");
    await authorize(c, deps, "brains.admin", { type: "workspace", id: ws });
    const row = await brains.profileFor(ws, id);
    if (!row) throw PerchError.notFound("model profile");
    await brains.removeProfile(row);
    return c.body(null, 204);
  });
}

function toCredential(view: ReturnType<Deps["brains"]["view"]>) {
  return {
    id: view.id,
    provider: view.provider,
    provider_name: view.providerName,
    kind: view.kind,
    scope: view.scope,
    label: view.label,
    base_url: view.baseUrl,
    status: view.status,
    owner_id: view.ownerId,
    hint: view.hint,
    created_at: view.createdAt,
  };
}

function toProfile(row: {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  credentialId: string | null;
  defaultFor: "chat" | "code" | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model_id: row.modelId,
    credential_id: row.credentialId,
    default_for: row.defaultFor,
    created_at: row.createdAt.toISOString(),
  };
}
