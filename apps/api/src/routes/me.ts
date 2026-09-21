import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { API_TOKEN_SCOPES } from "@perch/db";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { emailVerified } from "../repos/users.ts";
import { findMembership } from "../repos/workspaces.ts";
import { createApiToken, listApiTokens, revokeApiToken } from "../services/tokens.ts";
import { updateProfile } from "../services/users.ts";
import { errorResponses, SESSION_ONLY, SESSION_OR_BEARER } from "./shared.ts";

export const meSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    email_verified: z.boolean(),
    name: z.string(),
    handle: z.string(),
    locale: z.string(),
    tz: z.string(),
    avatar_file_id: z.uuid().nullable(),
    auth_kind: z.enum(["session", "token"]),
  })
  .openapi("Me");

const patchMeSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    handle: z.string().trim().min(2).max(32).optional(),
    locale: z.string().min(2).max(16).optional(),
    tz: z.string().min(1).max(64).optional(),
  })
  .openapi("MePatch");

const tokenSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    scopes: z.array(z.enum(API_TOKEN_SCOPES)),
    workspace_id: z.uuid().nullable(),
    last_used_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("ApiToken");

const createTokenSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1),
    workspace_id: z.uuid().optional(),
    expires_at: z.iso.datetime().optional(),
  })
  .openapi("ApiTokenCreate");

const createdTokenSchema = tokenSchema
  .extend({ token: z.string().openapi({ description: "Shown once; only a hash is stored." }) })
  .openapi("ApiTokenCreated");

const getMe = createRoute({
  method: "get",
  path: "/api/me",
  tags: ["me"],
  summary: "The signed-in user",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  responses: {
    200: { description: "Profile", content: { "application/json": { schema: meSchema } } },
    ...errorResponses(403),
  },
});

const patchMe = createRoute({
  method: "patch",
  path: "/api/me",
  tags: ["me"],
  summary: "Update the signed-in user's profile",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { body: { content: { "application/json": { schema: patchMeSchema } } } },
  responses: {
    200: { description: "Updated profile", content: { "application/json": { schema: meSchema } } },
    ...errorResponses(403, 409, 422),
  },
});

const listTokens = createRoute({
  method: "get",
  path: "/api/me/tokens",
  tags: ["me"],
  summary: "List api tokens",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  responses: {
    200: {
      description: "Tokens (never the secret)",
      content: { "application/json": { schema: z.object({ tokens: z.array(tokenSchema) }) } },
    },
    ...errorResponses(403),
  },
});

const createToken = createRoute({
  method: "post",
  path: "/api/me/tokens",
  tags: ["me"],
  summary: "Create an api token",
  middleware: [requireUser] as const,
  security: SESSION_ONLY,
  request: { body: { content: { "application/json": { schema: createTokenSchema } } } },
  responses: {
    201: {
      description: "The new token, shown once",
      content: { "application/json": { schema: createdTokenSchema } },
    },
    ...errorResponses(403, 422),
  },
});

const deleteTokenRoute = createRoute({
  method: "delete",
  path: "/api/me/tokens/{id}",
  tags: ["me"],
  summary: "Revoke an api token",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: "Revoked" },
    ...errorResponses(403, 404),
  },
});

function tokenBody(row: {
  id: string;
  name: string;
  scopes: readonly string[];
  workspaceId: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    scopes: [...row.scopes] as z.infer<typeof tokenSchema>["scopes"],
    workspace_id: row.workspaceId,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

export function registerMe(app: OpenAPIHono<AppEnv>, deps: Pick<Deps, "db">): void {
  app.openapi(getMe, async (c) => {
    const user = currentUser(c);
    return c.json(
      {
        id: user.id,
        email: user.email,
        email_verified: await emailVerified(deps.db.db, user.authUserId),
        name: user.name,
        handle: user.handle,
        locale: user.locale,
        tz: user.tz,
        avatar_file_id: user.avatarFileId,
        auth_kind: c.get("authKind") ?? "session",
      },
      200,
    );
  });

  app.openapi(patchMe, async (c) => {
    const user = currentUser(c);
    const updated = await updateProfile(deps.db.db, user, c.req.valid("json"));
    return c.json(
      {
        id: updated.id,
        email: updated.email,
        email_verified: await emailVerified(deps.db.db, updated.authUserId),
        name: updated.name,
        handle: updated.handle,
        locale: updated.locale,
        tz: updated.tz,
        avatar_file_id: updated.avatarFileId,
        auth_kind: c.get("authKind") ?? "session",
      },
      200,
    );
  });

  app.openapi(listTokens, async (c) => {
    const user = currentUser(c);
    const rows = await listApiTokens(deps.db.db, user.id);
    return c.json({ tokens: rows.map(tokenBody) }, 200);
  });

  app.openapi(createToken, async (c) => {
    const user = currentUser(c);
    const body = c.req.valid("json");
    // A token bound to a workspace is bound to a membership: the MCP routes take the workspace
    // from the token rather than from the path, so the binding is checked here, when it is made,
    // and again on every use (routes/mcp.ts), so that leaving the workspace ends it.
    if (body.workspace_id && !(await findMembership(deps.db.db, body.workspace_id, user.id))) {
      throw PerchError.forbidden("not a member of that workspace", {
        workspace_id: body.workspace_id,
      });
    }
    const created = await createApiToken(deps.db.db, {
      userId: user.id,
      name: body.name,
      scopes: body.scopes,
      workspaceId: body.workspace_id ?? null,
      expiresAt: body.expires_at ? new Date(body.expires_at) : null,
    });
    return c.json({ ...tokenBody(created.row), token: created.token }, 201);
  });

  app.openapi(deleteTokenRoute, async (c) => {
    const user = currentUser(c);
    await revokeApiToken(deps.db.db, user.id, c.req.valid("param").id);
    return c.body(null, 204);
  });
}
