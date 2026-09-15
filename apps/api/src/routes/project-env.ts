/**
 * A project's environment over REST (spec §7.1 `.../projects (+ clone, env, config)`; task 2.13).
 *
 * Values go in and never come back: the api answers with the keys, where each one came from and
 * when it was last set. What a person wants to know about an environment is what is in it, and what
 * nobody should be able to ask an api for is the contents of a `.env`.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { PROJECT_ENV_SOURCES } from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { ENV_KEY, type EnvEntry, listEnv, removeEnv, setEnv } from "../services/project-env.ts";
import { getProject } from "../services/projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });

const entrySchema = z
  .object({
    key: z.string(),
    source: z.enum(PROJECT_ENV_SOURCES),
    updated_at: z.string(),
  })
  .openapi("ProjectEnvEntry");

const listSchema = z.object({ vars: z.array(entrySchema) }).openapi("ProjectEnv");

const writeBody = z
  .object({
    vars: z
      .array(
        z.object({
          key: z.string().min(1).max(200).regex(ENV_KEY),
          value: z.string().max(100_000),
          source: z.enum(PROJECT_ENV_SOURCES).optional(),
        }),
      )
      .max(500),
    /** Keys to take out in the same breath. */
    remove: z.array(z.string().min(1).max(200)).max(500).optional(),
  })
  .openapi("WriteProjectEnv");

const listRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/env",
  tags: ["projects"],
  summary: "What this project's environment carries (keys only)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: { description: "The keys", content: { "application/json": { schema: listSchema } } },
    ...errorResponses(403, 404),
  },
});

const writeRoute = createRoute({
  method: "put",
  path: "/api/workspaces/{ws}/projects/{project}/env",
  tags: ["projects"],
  summary: "Set or remove environment variables",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: { content: { "application/json": { schema: writeBody } } },
  },
  responses: {
    200: { description: "The keys", content: { "application/json": { schema: listSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

export function registerProjectEnv(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const services = { db: deps.db.db, vault: deps.vault };

  const target = async (ws: string, id: string) => {
    const project = await getProject(deps.db.db, ws, id);
    if (!project) throw PerchError.notFound("project");
    return project;
  };

  app.openapi(listRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    await authorize(c, deps, "projects.read", { type: "workspace", id: ws });
    const vars = await listEnv(services, await target(ws, id));
    return c.json({ vars: vars.map(body) }, 200);
  });

  app.openapi(writeRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const input = c.req.valid("json");
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const project = await target(ws, id);
    if (input.remove?.length) await removeEnv(services, project, input.remove);
    const vars =
      input.vars.length > 0
        ? await setEnv(services, project, input.vars)
        : await listEnv(services, project);
    // What changed, never what it is: the audit log gets the keys and nothing else.
    await deps.bus.publish(
      "project.updated",
      {
        workspaceId: ws,
        projectId: project.id,
        changes: [
          ...input.vars.map((one) => `env:${one.key}`),
          ...(input.remove ?? []).map((key) => `env:-${key}`),
        ],
      },
      actorOf(c),
    );
    return c.json({ vars: vars.map(body) }, 200);
  });
}

function body(entry: EnvEntry) {
  return { key: entry.key, source: entry.source, updated_at: entry.updatedAt.toISOString() };
}
