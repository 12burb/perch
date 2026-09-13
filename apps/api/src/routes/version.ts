import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv, Deps } from "../context.ts";

export const versionResponseSchema = z
  .object({
    version: z.string().openapi({ example: "0.1.0" }),
    commit: z.string().nullable().openapi({ example: "85b6bb8" }),
    api_version: z.string().openapi({ example: "2026-09-01" }),
    runtime: z.string().openapi({ example: "bun 1.3.11" }),
    mode: z.enum(["laptop", "team"]),
  })
  .openapi("Version");

export type VersionResponse = z.infer<typeof versionResponseSchema>;

const versionRoute = createRoute({
  method: "get",
  path: "/api/version",
  tags: ["system"],
  summary: "Build and contract version",
  responses: {
    200: {
      description: "The running version, commit, REST contract version, runtime, and mode",
      content: { "application/json": { schema: versionResponseSchema } },
    },
  },
});

export function registerVersion(app: OpenAPIHono<AppEnv>, deps: Pick<Deps, "version">): void {
  app.openapi(versionRoute, (c) => {
    const body: VersionResponse = {
      version: deps.version.version,
      commit: deps.version.commit ?? null,
      api_version: deps.version.apiVersion,
      runtime: deps.version.runtime,
      mode: deps.version.mode,
    };
    return c.json(body, 200);
  });
}
