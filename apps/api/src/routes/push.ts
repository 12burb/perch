/**
 * Push subscriptions over REST (task 2.3). Spec §7.1 does not name these paths — they sit under
 * `/api/me`, because a subscription is one person's own device and belongs nowhere else (ADR-0093).
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { publicKey, subscribe, subscriptionsOf, unsubscribe } from "../services/push.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const keySchema = z
  .object({ public_key: z.string().openapi({ description: "The instance's VAPID public key" }) })
  .openapi("PushKey");

const subscriptionSchema = z
  .object({
    id: z.uuid(),
    endpoint: z.string(),
    user_agent: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("PushSubscription");

const subscribeBody = z
  .object({
    endpoint: z.url().max(2000),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) }),
  })
  .openapi("PushSubscribe");

const keyRoute = createRoute({
  method: "get",
  path: "/api/me/push-key",
  tags: ["me"],
  summary: "The key a browser subscribes with",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  responses: {
    200: { description: "The key", content: { "application/json": { schema: keySchema } } },
    ...errorResponses(403),
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/api/me/push-subscriptions",
  tags: ["me"],
  summary: "The devices you have said yes on",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  responses: {
    200: {
      description: "Subscriptions",
      content: {
        "application/json": { schema: z.object({ subscriptions: z.array(subscriptionSchema) }) },
      },
    },
    ...errorResponses(403),
  },
});

const subscribeRoute = createRoute({
  method: "post",
  path: "/api/me/push-subscriptions",
  tags: ["me"],
  summary: "Notify this device",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { body: { content: { "application/json": { schema: subscribeBody } } } },
  responses: {
    201: {
      description: "The subscription",
      content: { "application/json": { schema: subscriptionSchema } },
    },
    ...errorResponses(403, 422),
  },
});

const unsubscribeRoute = createRoute({
  method: "delete",
  path: "/api/me/push-subscriptions",
  tags: ["me"],
  summary: "Stop notifying this device",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    body: {
      content: { "application/json": { schema: z.object({ endpoint: z.url().max(2000) }) } },
    },
  },
  responses: { 204: { description: "Gone" }, ...errorResponses(403, 422) },
});

export function registerPush(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.openapi(keyRoute, async (c) => {
    return c.json({ public_key: await publicKey(deps) }, 200);
  });

  app.openapi(listRoute, async (c) => {
    const rows = await subscriptionsOf(deps.db.db, currentUser(c).id);
    return c.json(
      {
        subscriptions: rows.map((row) => ({
          id: row.id,
          endpoint: row.endpoint,
          user_agent: row.userAgent,
          created_at: row.createdAt.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi(subscribeRoute, async (c) => {
    const body = c.req.valid("json");
    const row = await subscribe(deps, {
      userId: currentUser(c).id,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: c.req.header("user-agent")?.slice(0, 300),
    });
    return c.json(
      {
        id: row.id,
        endpoint: row.endpoint,
        user_agent: row.userAgent,
        created_at: row.createdAt.toISOString(),
      },
      201,
    );
  });

  app.openapi(unsubscribeRoute, async (c) => {
    await unsubscribe(deps, currentUser(c).id, c.req.valid("json").endpoint);
    return c.body(null, 204);
  });
}
