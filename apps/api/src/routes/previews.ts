/**
 * Previews over REST (spec §7.1 `.../projects/{p}/previews`, `.../previews/{port}/share`,
 * `/api/preview-shares/{id}`; task 1.18).
 *
 * The listing is what the Preview tab draws: every port the project's runners are serving, the URL
 * to open each on, and the dev command the project's own config names so the Start button has
 * something to run. A share is created once and its link is shown once — Perch keeps a hash.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { PreviewShare } from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { getShare } from "../repos/previews.ts";
import { findWorkspaceById } from "../repos/workspaces.ts";
import { configPath, previewCommand } from "../services/previews.ts";
import { getProject } from "../services/projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });
const portParam = projectParam.extend({ port: z.coerce.number().int().min(1).max(65535) });
const shareParam = z.object({ id: z.uuid() });

const portSchema = z
  .object({
    port: z.number().int(),
    url: z.url(),
    /** Empty when the port is configured but nothing is serving it yet. */
    runner_id: z.string(),
    configured: z.boolean(),
    /**
     * A short-lived ticket that lets this member's browser onto the preview's own origin, where a
     * Perch session cookie does not reach (ADR-0084). Empty when nothing is serving the port.
     */
    ticket: z.string(),
  })
  .openapi("PreviewPort");

const shareSchema = z
  .object({
    id: z.uuid(),
    port: z.number().int(),
    path: z.string(),
    public: z.boolean(),
    expires_at: z.string(),
    created_at: z.string(),
    revoked_at: z.string().nullable(),
  })
  .openapi("PreviewShare");

const createdShareSchema = shareSchema
  .extend({
    url: z.url().openapi({ description: "Shown once; only a hash of its token is stored." }),
  })
  .openapi("PreviewShareCreated");

const previewsSchema = z
  .object({
    ports: z.array(portSchema),
    shares: z.array(shareSchema),
    /** The project's own `preview` block (spec §5.1), so the tab knows what to start and where. */
    config: z.object({
      command: z.string().nullable(),
      port: z.number().int().nullable(),
      path: z.string(),
      routes: z.array(z.string()),
    }),
  })
  .openapi("Previews");

const listRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/previews",
  tags: ["previews"],
  summary: "The ports this project is serving, and the links shared from them",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: { description: "Previews", content: { "application/json": { schema: previewsSchema } } },
    ...errorResponses(403, 404),
  },
});

const shareBody = z
  .object({
    path: z.string().max(2048).optional(),
    /** A link anyone with it may open, rather than one only signed-in members may. */
    public: z.boolean().default(false),
    expires_in_hours: z.number().int().min(1).max(720).optional(),
  })
  .openapi("PreviewShareCreate");

const createShareRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/previews/{port}/share",
  tags: ["previews"],
  summary: "Share a preview by link, expiring and revocable",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: portParam,
    body: { content: { "application/json": { schema: shareBody } } },
  },
  responses: {
    201: {
      description: "The share, with its link shown once",
      content: { "application/json": { schema: createdShareSchema } },
    },
    ...errorResponses(403, 404, 409),
  },
});

const revokeRoute = createRoute({
  method: "delete",
  path: "/api/preview-shares/{id}",
  tags: ["previews"],
  summary: "Revoke a share link",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: shareParam },
  responses: { 204: { description: "Revoked" }, ...errorResponses(403, 404, 409) },
});

function toShare(share: PreviewShare) {
  return {
    id: share.id,
    port: share.port,
    path: share.path,
    public: share.public,
    expires_at: share.expiresAt.toISOString(),
    created_at: share.createdAt.toISOString(),
    revoked_at: share.revokedAt ? share.revokedAt.toISOString() : null,
  };
}

export function registerPreviews(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.openapi(listRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    await authorize(c, deps, "previews.read", { type: "workspace", id: ws });
    const workspace = await findWorkspaceById(deps.db.db, ws);
    const project = workspace ? await getProject(deps.db.db, ws, projectId) : null;
    if (!workspace || !project) throw PerchError.notFound("project");
    const ports = deps.previews.ports(workspace, project);
    const shares = await deps.previews.shares(workspace, project);
    const userId = currentUser(c).id;
    const withTickets = await Promise.all(
      ports.map(async (port) => ({
        port: port.port,
        url: port.url,
        runner_id: port.runnerId,
        configured: port.configured,
        ticket: port.runnerId ? await deps.previews.ticket(ws, userId, port.port) : "",
      })),
    );
    return c.json(
      {
        ports: withTickets,
        shares: shares.map(toShare),
        config: {
          command: previewCommand(project) ?? null,
          port: project.config?.preview?.port ?? null,
          path: configPath(project),
          routes: project.config?.preview?.routes ?? [],
        },
      },
      200,
    );
  });

  app.openapi(createShareRoute, async (c) => {
    const { ws, project: projectId, port } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "previews.share", { type: "workspace", id: ws });
    const workspace = await findWorkspaceById(deps.db.db, ws);
    const project = workspace ? await getProject(deps.db.db, ws, projectId) : null;
    if (!workspace || !project) throw PerchError.notFound("project");
    const created = await deps.previews.createShare({
      workspace,
      project,
      port,
      ...(body.path ? { path: body.path } : {}),
      public: body.public,
      ...(body.expires_in_hours ? { expiresInMs: body.expires_in_hours * 60 * 60 * 1000 } : {}),
      userId: currentUser(c).id,
      by: actorOf(c),
    });
    return c.json({ ...toShare(created.share), url: created.url }, 201);
  });

  app.openapi(revokeRoute, async (c) => {
    const { id } = c.req.valid("param");
    const share = await getShare(deps.db.db, id);
    if (!share) throw PerchError.notFound("preview share");
    await authorize(c, deps, "previews.share", { type: "workspace", id: share.workspaceId });
    await deps.previews.revoke(share, actorOf(c));
    return c.body(null, 204);
  });
}
