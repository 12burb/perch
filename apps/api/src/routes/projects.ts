/**
 * Projects of a workspace (spec §5.1, §7.1 `/api/workspaces/{ws}/projects (+ clone, …)`, task 1.4):
 * create one empty or for uploads, clone one over HTTPS (with a token) or SSH (with the workspace's
 * deploy key), list them with their setup status, upload files into one, delete one; and the
 * workspace deploy key (read by members, rotated by admins).
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Project } from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import {
  type DeployKeyView,
  getOrCreateDeployKey,
  rotateDeployKey,
} from "../services/deploy-keys.ts";
import {
  type CloneAuth,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  type ProjectDeps,
  uploadProjectFiles,
} from "../services/projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const wsParam = z.object({ ws: z.uuid() });
const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });

export const projectSchema = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    key: z.string(),
    name: z.string(),
    source: z.enum(["empty", "upload", "clone"]),
    status: z.enum(["pending", "setting_up", "ready", "error"]),
    status_message: z.string().nullable(),
    repo_url: z.string().nullable(),
    default_branch: z.string(),
    default_engine: z.string(),
    runner_id: z.uuid().nullable(),
    head: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
    config_error: z.string().nullable(),
    devcontainer: z.record(z.string(), z.unknown()).nullable(),
    created_by: z.uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Project");

export function projectBody(row: Project): z.infer<typeof projectSchema> {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    key: row.key,
    name: row.name,
    source: row.source,
    status: row.status,
    status_message: row.statusMessage,
    repo_url: row.repoUrl,
    default_branch: row.defaultBranch,
    default_engine: row.defaultEngine,
    runner_id: row.runnerId,
    head: row.head,
    config: row.config,
    config_error: row.configError,
    devcontainer: row.devcontainer ?? null,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const deployKeySchema = z
  .object({
    public_key: z.string(),
    fingerprint: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("DeployKey");

function deployKeyBody(view: DeployKeyView): z.infer<typeof deployKeySchema> {
  return {
    public_key: view.publicKey,
    fingerprint: view.fingerprint,
    created_at: view.createdAt.toISOString(),
    updated_at: view.updatedAt.toISOString(),
  };
}

const nameSchema = z.string().trim().min(1).max(80);
const keySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/)
  .optional();
const branchSchema = z.string().trim().min(1).max(200).optional();

const cloneAuthSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("token"),
    token: z.string().min(1).max(4096),
    username: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({ kind: z.literal("deploy_key") }),
  /** A connection (task 1.16): Perch mints the token when the clone runs. */
  z.object({ kind: z.literal("connection"), connection_id: z.uuid() }),
]);

const listProjectsRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects",
  tags: ["projects"],
  summary: "Projects of a workspace with their setup status",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "Projects, newest first",
      content: { "application/json": { schema: z.object({ projects: z.array(projectSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const createProjectRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects",
  tags: ["projects"],
  summary: "Create an empty project, or one to upload files into",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: wsParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: nameSchema,
            key: keySchema,
            source: z.enum(["empty", "upload"]).optional(),
            default_branch: branchSchema,
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "The project; its directory is being set up (status pending → ready)",
      content: { "application/json": { schema: projectSchema } },
    },
    ...errorResponses(403, 404, 409, 422),
  },
});

const cloneProjectRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/clone",
  tags: ["projects"],
  summary: "Clone a repository: public, with a token, or with the workspace deploy key",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: wsParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: nameSchema,
            key: keySchema,
            repo_url: z.string().trim().min(1).max(2048),
            branch: branchSchema,
            auth: cloneAuthSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "The project; the clone runs on a runner (status pending → ready or error)",
      content: { "application/json": { schema: projectSchema } },
    },
    ...errorResponses(403, 404, 409, 422),
  },
});

const getProjectRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}",
  tags: ["projects"],
  summary: "A project",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: { description: "The project", content: { "application/json": { schema: projectSchema } } },
    ...errorResponses(403, 404),
  },
});

const deleteProjectRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/projects/{project}",
  tags: ["projects"],
  summary: "Delete a project and its directory on the runner",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: { 204: { description: "Deleted" }, ...errorResponses(403, 404) },
});

const fileSchema = z
  .custom<File>((value) => value instanceof File, "expected a file")
  .openapi({ type: "string", format: "binary" });

const uploadFilesRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/files",
  tags: ["projects"],
  summary: "Upload files into a project (each part's filename is its path in the project)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({ file: z.union([fileSchema, z.array(fileSchema)]) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "How many files were written",
      content: { "application/json": { schema: z.object({ written: z.number().int() }) } },
    },
    ...errorResponses(403, 404, 409, 422),
  },
});

const deployKeyRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/deploy-key",
  tags: ["projects"],
  summary: "The workspace's SSH deploy key (public half), minted on first read",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "The public key to add to repositories",
      content: { "application/json": { schema: deployKeySchema } },
    },
    ...errorResponses(403, 404),
  },
});

const rotateDeployKeyRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/deploy-key/rotate",
  tags: ["projects"],
  summary: "Replace the workspace's deploy key (admins)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "The new public key",
      content: { "application/json": { schema: deployKeySchema } },
    },
    ...errorResponses(403, 404),
  },
});

/** The wire shape is snake_case; the service's is not. */
function cloneAuthOf(auth: z.infer<typeof cloneAuthSchema>): CloneAuth {
  return auth.kind === "connection"
    ? { kind: "connection", connectionId: auth.connection_id }
    : auth;
}

export function projectDeps(deps: Deps): ProjectDeps {
  return {
    db: deps.db.db,
    bus: deps.bus,
    vault: deps.vault,
    queue: deps.queue,
    registry: deps.runners,
    log: deps.log,
    // A clone on a connection (task 1.16): the token is minted for that one clone and never kept.
    connectionToken: async ({ workspaceId, userId, connectionId }) => {
      const row = await deps.connections.connectionFor(workspaceId, userId, connectionId);
      if (!row) throw PerchError.notFound("connection");
      return deps.connections.tokenFor(row);
    },
  };
}

export function registerProjects(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const services = projectDeps(deps);

  app.openapi(listProjectsRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "projects.read", { type: "workspace", id: ws });
    const rows = await listProjects(deps.db.db, ws);
    return c.json({ projects: rows.map(projectBody) }, 200);
  });

  app.openapi(createProjectRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "projects.create", { type: "workspace", id: ws });
    const user = currentUser(c);
    const { project } = await createProject(services, {
      workspaceId: ws,
      name: body.name,
      ...(body.key ? { key: body.key } : {}),
      source:
        body.source === "upload"
          ? { kind: "upload" }
          : {
              kind: "empty",
              ...(body.default_branch ? { defaultBranch: body.default_branch } : {}),
            },
      userId: user.id,
      by: actorOf(c),
    });
    return c.json(projectBody(project), 201);
  });

  app.openapi(cloneProjectRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "projects.create", { type: "workspace", id: ws });
    const user = currentUser(c);
    const { project } = await createProject(services, {
      workspaceId: ws,
      name: body.name,
      ...(body.key ? { key: body.key } : {}),
      source: {
        kind: "clone",
        repoUrl: body.repo_url,
        ...(body.branch ? { branch: body.branch } : {}),
        ...(body.auth ? { auth: cloneAuthOf(body.auth) } : {}),
      },
      userId: user.id,
      by: actorOf(c),
    });
    return c.json(projectBody(project), 201);
  });

  app.openapi(getProjectRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    await authorize(c, deps, "projects.read", { type: "workspace", id: ws });
    const project = await getProject(deps.db.db, ws, id);
    if (!project) throw PerchError.notFound("project");
    return c.json(projectBody(project), 200);
  });

  app.openapi(deleteProjectRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    await authorize(c, deps, "projects.delete", { type: "workspace", id: ws });
    const project = await getProject(deps.db.db, ws, id);
    if (!project) throw PerchError.notFound("project");
    await deleteProject(services, project, currentUser(c).id, actorOf(c));
    return c.body(null, 204);
  });

  app.openapi(uploadFilesRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    const form = c.req.valid("form");
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const project = await getProject(deps.db.db, ws, id);
    if (!project) throw PerchError.notFound("project");
    const files = Array.isArray(form.file) ? form.file : [form.file];
    const contents = await Promise.all(
      files.map(async (file) => ({
        path: file.name,
        content: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    const result = await uploadProjectFiles(
      services,
      project,
      contents,
      currentUser(c).id,
      actorOf(c),
    );
    return c.json(result, 200);
  });

  app.openapi(deployKeyRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "deploy_key.read", { type: "workspace", id: ws });
    const view = await getOrCreateDeployKey(services, ws);
    return c.json(deployKeyBody(view), 200);
  });

  app.openapi(rotateDeployKeyRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "deploy_key.rotate", { type: "workspace", id: ws });
    const view = await rotateDeployKey(services, ws, actorOf(c));
    return c.json(deployKeyBody(view), 200);
  });
}
