import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv, Deps } from "../context.ts";

export const healthResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded"]).openapi({ example: "ok" }),
    checks: z.object({
      database: z.enum(["ok", "error"]),
    }),
    ts: z.string().openapi({ example: "2026-09-13T10:00:00.000Z" }),
  })
  .openapi("Health");

export type HealthResponse = z.infer<typeof healthResponseSchema>;

const healthRoute = createRoute({
  method: "get",
  path: "/api/health",
  tags: ["system"],
  summary: "Liveness and readiness",
  description: "Reports whether the api can serve requests and whether its database answers.",
  responses: {
    200: {
      description: "Healthy or degraded, with a check per dependency",
      content: { "application/json": { schema: healthResponseSchema } },
    },
  },
});

export function registerHealth(app: OpenAPIHono<AppEnv>, deps: Pick<Deps, "db">): void {
  app.openapi(healthRoute, async (c) => {
    let database: "ok" | "error" = "ok";
    try {
      await deps.db.db.execute("select 1");
    } catch {
      database = "error";
    }
    const body: HealthResponse = {
      status: database === "ok" ? "ok" : "degraded",
      checks: { database },
      ts: new Date().toISOString(),
    };
    return c.json(body, 200);
  });
}
