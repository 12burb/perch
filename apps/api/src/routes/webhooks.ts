/**
 * Inbound webhooks over REST (spec §3.5 "inbound webhooks at /hooks/:provider/:id with signature
 * verification"; §7.1; task 3.4).
 *
 * Two halves that could not be more different. The management routes are ordinary: a member with
 * `connections.admin` makes an endpoint, lists them, takes one away. The delivery route is the only
 * unauthenticated write in Perch — the signature is the authentication, which is why it reads the
 * body raw and hands it to the verifier exactly as it arrived.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { webhookUrl } from "@perch/connect";
import type { Webhook } from "@perch/db";
import type { Context } from "hono";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { MAX_DELIVERY_BYTES } from "../services/webhooks.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const wsParam = z.object({ ws: z.uuid() });

const webhookSchema = z
  .object({
    id: z.uuid(),
    provider: z.string(),
    name: z.string(),
    channel_id: z.uuid(),
    connection_id: z.uuid().nullable(),
    /** Where the provider posts. The secret is not here: it was shown once. */
    url: z.string(),
    deliveries: z.number().int(),
    last_delivery_at: z.string().nullable(),
    status: z.enum(["active", "paused"]),
    created_at: z.string(),
  })
  .openapi("Webhook");

const createBody = z
  .object({
    provider: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    channel_id: z.uuid(),
    connection_id: z.uuid().optional(),
  })
  .openapi("CreateWebhook");

const listRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/webhooks",
  tags: ["connections"],
  summary: "The inbound webhooks this workspace answers",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "The endpoints",
      content: { "application/json": { schema: z.object({ webhooks: z.array(webhookSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/webhooks",
  tags: ["connections"],
  summary: "Make an endpoint a provider can post to; the secret is shown exactly once",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam, body: { content: { "application/json": { schema: createBody } } } },
  responses: {
    201: {
      description: "The endpoint, and its secret",
      content: {
        "application/json": {
          schema: z.object({ webhook: webhookSchema, secret: z.string() }),
        },
      },
    },
    ...errorResponses(403, 404, 422),
  },
});

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/webhooks/{id}",
  tags: ["connections"],
  summary: "Stop answering on an endpoint",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam.extend({ id: z.uuid() }) },
  responses: { 204: { description: "Gone" }, ...errorResponses(403, 404) },
});

export function registerWebhooks(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const view = (row: Webhook) => ({
    id: row.id,
    provider: row.provider,
    name: row.name,
    channel_id: row.channelId,
    connection_id: row.connectionId,
    url: webhookUrl(deps.env.publicUrl, row.provider, row.id),
    deliveries: row.deliveries,
    last_delivery_at: row.lastDeliveryAt?.toISOString() ?? null,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  });

  app.openapi(listRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "connections.admin", { type: "workspace", id: ws });
    return c.json({ webhooks: (await deps.webhooks.list(ws)).map(view) }, 200);
  });

  app.openapi(createRouteDef, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "connections.admin", { type: "workspace", id: ws });
    const made = await deps.webhooks.create({
      workspaceId: ws,
      provider: body.provider,
      name: body.name,
      channelId: body.channel_id,
      ...(body.connection_id ? { connectionId: body.connection_id } : {}),
      createdBy: currentUser(c).id,
      by: actorOf(c),
    });
    return c.json({ webhook: view(made.webhook), secret: made.secret }, 201);
  });

  app.openapi(deleteRouteDef, async (c) => {
    const { ws, id } = c.req.valid("param");
    await authorize(c, deps, "connections.admin", { type: "workspace", id: ws });
    if (!(await deps.webhooks.remove(ws, id))) throw PerchError.notFound("webhook");
    return c.body(null, 204);
  });

  /**
   * The delivery itself. No session, no bearer: the signature is what says who this is, and it is
   * computed over the body exactly as it arrived — so the body is read raw and never re-serialized.
   */
  app.post("/hooks/:provider/:id", async (c: Context<AppEnv>) => {
    const provider = c.req.param("provider") ?? "";
    const id = c.req.param("id") ?? "";
    if (!z.uuid().safeParse(id).success) throw PerchError.notFound("webhook");
    const body = await c.req.text();
    if (body.length > MAX_DELIVERY_BYTES) throw PerchError.validation("that delivery is too big");
    const result = await deps.webhooks.deliver({
      provider,
      id,
      headers: c.req.raw.headers,
      body,
      by: { actor: { type: "system" }, meta: {} },
    });
    // 200 either way: a provider that is told anything else retries, and a duplicate is not a
    // failure — it is a provider being careful.
    return c.json({ ok: true, status: result.status }, 200);
  });
}
