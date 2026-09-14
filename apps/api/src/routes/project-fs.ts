/**
 * A project's files through the api (task 1.6, ADR-0071): the editor's list, read, write, stat, and
 * search, each forwarded to the project's runner as the matching §7.6 fs method with the member as
 * user_id, the runner's policy answer mapped to §7.8 (451 for a refusal). Paths are validated here
 * too: relative, no `..`, no drive letters.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  fsListResultSchema,
  fsReadResultSchema,
  fsSearchResultSchema,
  fsStatResultSchema,
} from "@perch/events";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { getProject, projectRunnerLink, validateProjectPath } from "../services/projects.ts";
import { runnerCall } from "../services/runners.ts";
import { projectDeps } from "./projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });
const pathQuery = z.object({ path: z.string().max(4096).optional() });
const flag = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

const fsErrors = errorResponses(403, 404, 409, 422, 451, 502);

const listRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/fs/list",
  tags: ["projects"],
  summary: "List a directory of the project (the root when path is empty)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam, query: pathQuery },
  responses: {
    200: {
      description: "Entries",
      content: { "application/json": { schema: fsListResultSchema } },
    },
    ...fsErrors,
  },
});

const readRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/fs/read",
  tags: ["projects"],
  summary: "Read a file of the project (utf8, or base64 for binary content)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam, query: z.object({ path: z.string().min(1).max(4096) }) },
  responses: {
    200: {
      description: "The file",
      content: { "application/json": { schema: fsReadResultSchema } },
    },
    ...fsErrors,
  },
});

const statRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/fs/stat",
  tags: ["projects"],
  summary: "Whether a path exists in the project, and what it is",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam, query: pathQuery },
  responses: {
    200: { description: "Stat", content: { "application/json": { schema: fsStatResultSchema } } },
    ...fsErrors,
  },
});

const writeRoute = createRoute({
  method: "put",
  path: "/api/workspaces/{ws}/projects/{project}/fs/write",
  tags: ["projects"],
  summary: "Write a file of the project (creating directories on the way)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            path: z.string().min(1).max(4096),
            content: z.string(),
            encoding: z.enum(["utf8", "base64"]).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Bytes written",
      content: { "application/json": { schema: z.object({ bytes: z.number().int() }) } },
    },
    ...fsErrors,
  },
});

const searchRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/fs/search",
  tags: ["projects"],
  summary: "Search the project's files (literal and smart-case unless told otherwise)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    query: z.object({
      q: z.string().min(1).max(1000),
      glob: z.string().max(200).optional(),
      limit: z.coerce.number().int().positive().max(2000).optional(),
      regex: flag,
      ignore_case: flag,
    }),
  },
  responses: {
    200: {
      description: "Matches",
      content: { "application/json": { schema: fsSearchResultSchema } },
    },
    ...fsErrors,
  },
});

export function registerProjectFs(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const services = projectDeps(deps);

  async function target(
    c: Parameters<Parameters<typeof app.openapi>[1]>[0],
    ws: string,
    projectId: string,
    action: "projects.read" | "projects.update",
  ) {
    await authorize(c, deps, action, { type: "workspace", id: ws });
    const project = await getProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const user = currentUser(c);
    const link = await projectRunnerLink(services, project, user.id);
    return { link, project, userId: user.id };
  }

  app.openapi(listRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const { path } = c.req.valid("query");
    const { link, project, userId } = await target(c, ws, id, "projects.read");
    const result = await runnerCall(link, "fs.list", {
      workspace_id: ws,
      user_id: userId,
      project: project.id,
      path: path ? validateProjectPath(path) : "",
    });
    return c.json(fsListResultSchema.parse(result), 200);
  });

  app.openapi(readRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const { path } = c.req.valid("query");
    const { link, project, userId } = await target(c, ws, id, "projects.read");
    const result = await runnerCall(link, "fs.read", {
      workspace_id: ws,
      user_id: userId,
      project: project.id,
      path: validateProjectPath(path),
    });
    return c.json(fsReadResultSchema.parse(result), 200);
  });

  app.openapi(statRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const { path } = c.req.valid("query");
    const { link, project, userId } = await target(c, ws, id, "projects.read");
    const result = await runnerCall(link, "fs.stat", {
      workspace_id: ws,
      user_id: userId,
      project: project.id,
      path: path ? validateProjectPath(path) : "",
    });
    return c.json(fsStatResultSchema.parse(result), 200);
  });

  app.openapi(writeRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const body = c.req.valid("json");
    const { link, project, userId } = await target(c, ws, id, "projects.update");
    const result = await runnerCall(link, "fs.write", {
      workspace_id: ws,
      user_id: userId,
      project: project.id,
      path: validateProjectPath(body.path),
      content: body.content,
      ...(body.encoding ? { encoding: body.encoding } : {}),
    });
    await deps.bus.publish(
      "project.updated",
      { workspaceId: ws, projectId: project.id, changes: ["files"] },
      actorOf(c),
    );
    return c.json(z.object({ bytes: z.number().int() }).parse(result), 200);
  });

  app.openapi(searchRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const query = c.req.valid("query");
    const { link, project, userId } = await target(c, ws, id, "projects.read");
    const result = await runnerCall(link, "fs.search", {
      workspace_id: ws,
      user_id: userId,
      project: project.id,
      query: query.q,
      ...(query.glob ? { glob: query.glob } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
      regex: query.regex,
      ignoreCase: query.ignore_case,
    });
    return c.json(fsSearchResultSchema.parse(result), 200);
  });
}
