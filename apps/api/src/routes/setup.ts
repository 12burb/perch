import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv, Deps } from "../context.ts";
import { completeSetup } from "../services/setup.ts";
import { errorResponses } from "./shared.ts";

const setupBodySchema = z
  .object({
    admin: z.object({
      name: z.string().trim().min(1).max(80),
      email: z.email(),
      password: z.string().min(10).max(256),
    }),
    workspace: z.object({ name: z.string().trim().min(1).max(80) }),
    public_url: z.url(),
    telemetry: z.boolean().default(false),
  })
  .openapi("SetupRequest");

const setupRoute = createRoute({
  method: "post",
  path: "/api/setup",
  tags: ["system"],
  summary:
    "Complete first-run setup: the admin account, the first workspace, the public URL, telemetry",
  request: { body: { content: { "application/json": { schema: setupBodySchema } } } },
  responses: {
    201: {
      description: "Setup complete; the admin is signed in (session cookie)",
      content: {
        "application/json": {
          schema: z
            .object({ user_id: z.uuid(), workspace_slug: z.string() })
            .openapi("SetupResult"),
        },
      },
    },
    ...errorResponses(409, 422),
  },
});

export function registerSetup(
  app: OpenAPIHono<AppEnv>,
  deps: Pick<Deps, "db" | "bus" | "auth" | "env">,
): void {
  app.openapi(setupRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await completeSetup(
      { db: deps.db.db, bus: deps.bus, auth: deps.auth, publicUrl: deps.env.publicUrl },
      {
        admin: body.admin,
        workspace: body.workspace,
        publicUrl: body.public_url,
        telemetry: body.telemetry,
      },
    );
    c.set("userId", result.userId);
    for (const cookie of result.headers.getSetCookie())
      c.header("set-cookie", cookie, { append: true });
    return c.json({ user_id: result.userId, workspace_slug: result.workspaceSlug }, 201);
  });
}
