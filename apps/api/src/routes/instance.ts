import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv, Deps } from "../context.ts";

/** Public instance facts the web client needs before anyone signs in (which sign-in methods exist). */
export const instanceResponseSchema = z
  .object({
    public_url: z.string(),
    mode: z.enum(["laptop", "team"]),
    auth: z.object({
      email_password: z.boolean(),
      passkeys: z.boolean(),
      oidc: z.boolean(),
    }),
  })
  .openapi("Instance");

const instanceRoute = createRoute({
  method: "get",
  path: "/api/instance",
  tags: ["system"],
  summary: "Public instance configuration",
  responses: {
    200: {
      description: "Which sign-in methods this instance offers",
      content: { "application/json": { schema: instanceResponseSchema } },
    },
  },
});

export function registerInstance(app: OpenAPIHono<AppEnv>, deps: Pick<Deps, "env">): void {
  app.openapi(instanceRoute, (c) =>
    c.json(
      {
        public_url: deps.env.publicUrl,
        mode: deps.env.mode,
        auth: { email_password: true, passkeys: true, oidc: deps.env.oidc !== undefined },
      },
      200,
    ),
  );
}
