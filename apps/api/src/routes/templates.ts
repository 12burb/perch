/**
 * The starter stacks (task 4.8; spec §10's Phase 4 line "one-click templates, starter stacks").
 *
 * They are the same for every workspace and every instance — files in `@perch/templates`, not rows
 * — so this is a catalogue rather than a resource: signed in to read it, and nothing to authorize
 * against. Making a project from one is `POST /api/workspaces/{ws}/projects/template`, which is
 * authorized like any other project creation.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { STACKS } from "@perch/templates";
import { requireUser } from "../auth/middleware.ts";
import type { AppEnv } from "../context.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const templateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    /** The port its dev server listens on, which the Preview tab watches. */
    port: z.number().int(),
    /** What starts it: the same command `.perch/project.json` will carry. */
    dev: z.string(),
    /** How many files the project starts with. */
    files: z.number().int(),
  })
  .openapi("Template");

const listRoute = createRoute({
  method: "get",
  path: "/api/templates",
  tags: ["templates"],
  summary: "The starter stacks a project can be made from",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  responses: {
    200: {
      description: "The starter stacks",
      content: { "application/json": { schema: z.object({ templates: z.array(templateSchema) }) } },
    },
    ...errorResponses(403),
  },
});

export function registerTemplates(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listRoute, (c) =>
    c.json(
      {
        templates: STACKS.map((stack) => ({
          id: stack.id,
          name: stack.name,
          description: stack.description,
          tags: [...stack.tags],
          port: stack.port,
          dev: stack.dev,
          files: Object.keys(stack.files).length,
        })),
      },
      200,
    ),
  );
}
