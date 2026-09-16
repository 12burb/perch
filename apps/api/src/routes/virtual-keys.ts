/**
 * Virtual keys over REST (spec §7.1 `.../virtual-keys`, §3.4; task 4.1).
 *
 * Minting one is an admin's act, because a key spends the workspace's credit. The key itself is
 * shown exactly once — the row keeps a hash and a prefix, the same way an api token does.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { KEY_SUBJECTS, type VirtualKey } from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const wsParam = z.object({ ws: z.uuid() });
const idParam = z.object({ id: z.uuid() });

const budgetSchema = z
  .object({
    /** Dollars. Absent means no ceiling at all. */
    limit_usd: z.number().min(0).max(1_000_000).optional(),
    period: z.enum(["day", "month", "total"]).optional(),
  })
  .openapi("KeyBudget");

const keySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    subject_type: z.enum(KEY_SUBJECTS),
    subject_id: z.uuid().nullable(),
    /** The first characters of the key, which is all that is kept of it. */
    prefix: z.string(),
    budget: budgetSchema,
    /** The model profiles this key may name; empty means the workspace's whole allow-list. */
    models: z.array(z.string()),
    expires_at: z.string().nullable(),
    revoked_at: z.string().nullable(),
    last_used_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("VirtualKey");

const createBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    subject_type: z.enum(KEY_SUBJECTS).default("external"),
    /** Who it speaks as. Required for a key that is a person, a bot or a runner. */
    subject_id: z.uuid().optional(),
    budget: budgetSchema.optional(),
    models: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
    expires_at: z.iso.datetime().optional(),
  })
  .openapi("CreateVirtualKey");

function view(row: VirtualKey) {
  return {
    id: row.id,
    name: row.name,
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    prefix: row.prefix,
    budget: {
      ...(row.budget.limitUsd === undefined ? {} : { limit_usd: row.budget.limitUsd }),
      ...(row.budget.period ? { period: row.budget.period } : {}),
    },
    models: row.models,
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/virtual-keys",
  tags: ["brains"],
  summary: "The keys this workspace has minted for /v1",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "Keys",
      content: { "application/json": { schema: z.object({ keys: z.array(keySchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/virtual-keys",
  tags: ["brains"],
  summary: "Mint a virtual key; the key itself is shown exactly once",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam, body: { content: { "application/json": { schema: createBody } } } },
  responses: {
    201: {
      description: "The key, and the row that will outlive it",
      content: {
        "application/json": {
          schema: z.object({ key: z.string(), virtual_key: keySchema }).openapi("MintedVirtualKey"),
        },
      },
    },
    ...errorResponses(403, 404, 422),
  },
});

const revokeRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/virtual-keys/{id}",
  tags: ["brains"],
  summary: "Revoke a key; what it spent stays in the ledger",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam.extend(idParam.shape) },
  responses: { 204: { description: "Revoked" }, ...errorResponses(403, 404) },
});

export function registerVirtualKeys(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.openapi(listRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "brains.admin", { type: "workspace", id: ws });
    return c.json({ keys: (await deps.virtualKeys.list(ws)).map(view) }, 200);
  });

  app.openapi(createRouteDef, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "brains.admin", { type: "workspace", id: ws });
    const body = c.req.valid("json");
    if (body.subject_type !== "external" && !body.subject_id) {
      throw PerchError.validation(`a ${body.subject_type} key needs a subject_id`);
    }
    const minted = await deps.virtualKeys.mint({
      workspaceId: ws,
      name: body.name,
      subjectType: body.subject_type,
      ...(body.subject_id ? { subjectId: body.subject_id } : {}),
      budget: {
        ...(body.budget?.limit_usd === undefined ? {} : { limitUsd: body.budget.limit_usd }),
        ...(body.budget?.period ? { period: body.budget.period } : {}),
      },
      models: body.models ?? [],
      ...(body.expires_at ? { expiresAt: new Date(body.expires_at) } : {}),
      createdBy: currentUser(c).id,
      by: actorOf(c),
    });
    return c.json({ key: minted.key, virtual_key: view(minted.row) }, 201);
  });

  app.openapi(revokeRoute, async (c) => {
    const { ws, id } = c.req.valid("param");
    await authorize(c, deps, "brains.admin", { type: "workspace", id: ws });
    await deps.virtualKeys.revoke(ws, id, actorOf(c));
    return c.body(null, 204);
  });
}
