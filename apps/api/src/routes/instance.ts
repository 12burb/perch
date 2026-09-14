import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv, Deps } from "../context.ts";
import { getSetting, isSetupComplete, SETTING_KEYS } from "../services/setup.ts";

/** Public instance facts the web client needs before anyone signs in (which sign-in methods exist). */
export const instanceResponseSchema = z
  .object({
    public_url: z.string(),
    mode: z.enum(["laptop", "team"]),
    /** False until the setup wizard (POST /api/setup) has run; sign-ups are refused meanwhile. */
    setup_complete: z.boolean(),
    telemetry: z.boolean(),
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

export function registerInstance(app: OpenAPIHono<AppEnv>, deps: Pick<Deps, "env" | "db">): void {
  app.openapi(instanceRoute, async (c) => {
    const [setupComplete, telemetrySetting] = await Promise.all([
      isSetupComplete(deps.db.db),
      getSetting<boolean>(deps.db.db, SETTING_KEYS.telemetry),
    ]);
    return c.json(
      {
        public_url: deps.env.publicUrl,
        mode: deps.env.mode,
        setup_complete: setupComplete,
        telemetry: deps.env.telemetry || telemetrySetting === true,
        auth: { email_password: true, passkeys: true, oidc: deps.env.oidc !== undefined },
      },
      200,
    );
  });
}
