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
import { screenshotResultSchema } from "@perch/events";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { insertMessage } from "../repos/messages.ts";
import { getShare } from "../repos/previews.ts";
import { findWorkspaceById } from "../repos/workspaces.ts";
import { channelFor } from "../services/channels.ts";
import { editElement } from "../services/element-edit.ts";
import { storeUpload } from "../services/files.ts";
import {
  configPath,
  type PreviewRunDeps,
  previewCommand,
  startPreview,
  stopPreview,
} from "../services/previews.ts";
import { getProject, projectRunnerLink } from "../services/projects.ts";
import { runnerCall } from "../services/runners.ts";
import { projectDeps } from "./projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });

/** What starting and stopping a dev server needs: the project's runner, its env, and the bus. */
function previewRunDeps(deps: Deps): PreviewRunDeps {
  return { db: deps.db.db, bus: deps.bus, registry: deps.runners, vault: deps.vault };
}
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

/**
 * A picture of the page the Preview tab is showing (spec §5.6 "Screenshot via headless Chromium in
 * the runner → attach to prompt or post to thread"; task 2.16). The browser runs on the runner,
 * because that is where the port is; what comes back is a file like any other.
 */
const screenshotRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/screenshot",
  tags: ["previews"],
  summary: "Take a picture of a preview page, and optionally post it in a channel",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: z.object({ ws: z.uuid(), project: z.uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              port: z.number().int().min(1).max(65535),
              path: z.string().max(2048).default("/"),
              width: z.number().int().min(200).max(4000).optional(),
              height: z.number().int().min(200).max(4000).optional(),
              /** Where to post it; left out, it is kept as a file and attached to the prompt. */
              channel_id: z.uuid().optional(),
              thread_root_id: z.uuid().optional(),
            })
            .openapi("TakeScreenshot"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "The picture",
      content: {
        "application/json": {
          schema: z
            .object({
              file_id: z.uuid(),
              url: z.string(),
              width: z.number().int(),
              height: z.number().int(),
              message_id: z.uuid().nullable(),
            })
            .openapi("Screenshot"),
        },
      },
    },
    ...errorResponses(403, 404, 409, 422),
  },
});

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

/**
 * A direct tweak, written to source (spec §5.6; task 3.21). It takes the element's own
 * `data-perch-src`, so the caller never says which file or which line — that is what makes the
 * edit deterministic rather than a guess about which `<div className="p-2">` was meant.
 */
const elementEditRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/element-edit",
  tags: ["previews"],
  summary: "Write a panel tweak back to the source it came from",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              /** `src/app.tsx:42:7`, off the element. */
              source: z.string().min(3).max(1000),
              class_name: z.string().max(2000).optional(),
              text: z.string().max(10_000).optional(),
            })
            .openapi("ElementEditRequest"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "What changed, and the diff of the one file",
      content: {
        "application/json": {
          schema: z.object({
            path: z.string(),
            changed: z.array(z.enum(["className", "text"])),
            diff: z.string(),
          }),
        },
      },
    },
    ...errorResponses(403, 404, 422, 502),
  },
});

/**
 * Preflight (spec §5.6; task 3.21): the project's own commands, then a look at each of its routes.
 * A channel gets the checklist as a card; without one it is just the answer.
 */
const preflightRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/preflight",
  tags: ["previews"],
  summary: "Run the project's checks and look at each of its routes",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: {
      // Running it needs nothing said: a caller that wants the card in a channel says so, and
      // everybody else sends no body at all rather than an empty object.
      required: false,
      content: {
        "application/json": {
          schema: z
            .object({
              channel_id: z.uuid().optional(),
              thread_root_id: z.uuid().optional(),
            })
            .openapi("PreflightRequest"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "The checklist",
      content: {
        "application/json": {
          schema: z.object({
            passed: z.boolean(),
            verdict: z.enum(["warn", "block"]),
            rows: z.array(
              z.object({
                name: z.string(),
                kind: z.enum(["command", "route"]),
                ok: z.boolean(),
                detail: z.string().optional(),
                file_id: z.uuid().optional(),
              }),
            ),
            message_id: z.uuid().nullable(),
          }),
        },
      },
    },
    ...errorResponses(403, 404, 422, 502),
  },
});

/**
 * The project's own dev server (task 4.8). Perch could watch a port; this starts what answers on
 * it. The command is never sent by the caller: it is the one `.perch/project.json` names.
 */
const previewRunSchema = z
  .object({
    running: z.boolean(),
    /** True when this call was the one that started it, rather than finding it already up. */
    started: z.boolean(),
    serving: z.boolean(),
    port: z.number().int().nullable(),
    pid: z.number().int().nullable(),
    command: z.string().nullable(),
    started_at: z.string().nullable(),
    exit_code: z.number().int().nullable(),
    /** The tail of the dev server's output, so a start that failed says why. */
    log: z.string(),
  })
  .openapi("PreviewRun");

const startRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/previews/start",
  tags: ["previews"],
  summary: "Start the project's dev server on its runner",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: {
      description: "The dev server, once its port answers or the wait runs out",
      content: { "application/json": { schema: previewRunSchema } },
    },
    ...errorResponses(403, 404, 409, 422, 502),
  },
});

const stopRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/previews/stop",
  tags: ["previews"],
  summary: "Stop the project's dev server",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: {
      description: "The dev server, stopped",
      content: { "application/json": { schema: previewRunSchema } },
    },
    ...errorResponses(403, 404, 409, 502),
  },
});

export function registerPreviews(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.openapi(preflightRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    const body = (c.req.valid("json") ?? {}) as {
      channel_id?: string;
      thread_root_id?: string;
    };
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const user = currentUser(c);
    const project = await getProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const link = await projectRunnerLink(projectDeps(deps), project, user.id);
    const port = project.config.preview?.port;
    const up = port
      ? deps.runners.forWorkspace(ws).some((one) => one.ports.some((each) => each.port === port))
      : false;
    const result = await deps.preflight.run({
      project,
      link,
      userId: user.id,
      ...(up && port ? { port } : {}),
    });

    // A picture belongs in a file, not in a JSON body: the row points at it.
    const rows: { row: (typeof result.rows)[number]; fileId?: string }[] = [];
    for (const row of result.rows) {
      if (!row.png) {
        rows.push({ row });
        continue;
      }
      const file = await storeUpload(
        { db: deps.db, env: { filesDir: deps.env.filesDir } },
        {
          workspaceId: ws,
          uploader: { type: "user", id: user.id },
          file: new File(
            [Buffer.from(row.png, "base64")],
            `${project.key}${row.name.replace(/[^a-zA-Z0-9]+/g, "-")}.png`.replace(/-+/g, "-"),
            { type: "image/png" },
          ),
        },
      );
      rows.push({ row, fileId: file.id });
    }

    let messageId: string | null = null;
    if (body.channel_id) {
      // The caller's own view of the channel (spec §2.1): a private one they are not in is not
      // a place they can post a card, any more than a message.
      const channel = await channelFor(deps, ws, body.channel_id, user.id);
      const message = await insertMessage(deps.db.db, {
        workspaceId: ws,
        channelId: channel.id,
        threadRootId: body.thread_root_id ?? null,
        authorType: "user",
        authorId: user.id,
        blocks: [
          {
            type: "preflight_card",
            state: result.passed ? "passed" : "failed",
            verdict: result.verdict,
            rows: rows.map(({ row, fileId }) => ({
              name: row.name,
              kind: row.kind,
              ok: row.ok,
              ...(row.detail === undefined ? {} : { detail: row.detail }),
              ...(fileId ? { fileId } : {}),
            })),
          },
        ],
      });
      messageId = message.id;
      await deps.bus.publish(
        "message.created",
        {
          workspaceId: ws,
          channelId: channel.id,
          messageId: message.id,
          ...(body.thread_root_id ? { threadRootId: body.thread_root_id } : {}),
          authorType: "user" as const,
          authorId: user.id,
        },
        { ...actorOf(c), topics: [`channel:${channel.id}`] },
      );
    }

    return c.json(
      {
        passed: result.passed,
        verdict: result.verdict,
        rows: rows.map(({ row, fileId }) => ({
          name: row.name,
          kind: row.kind,
          ok: row.ok,
          ...(row.detail === undefined ? {} : { detail: row.detail }),
          ...(fileId ? { file_id: fileId } : {}),
        })),
        message_id: messageId,
      },
      200,
    );
  });

  app.openapi(elementEditRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    // Writing a file is writing a file, whoever pressed the button.
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const user = currentUser(c);
    const project = await getProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const link = await projectRunnerLink(projectDeps(deps), project, user.id);
    return c.json(
      await editElement({
        project,
        link,
        userId: user.id,
        source: body.source,
        edit: {
          ...(body.class_name === undefined ? {} : { className: body.class_name }),
          ...(body.text === undefined ? {} : { text: body.text }),
        },
      }),
      200,
    );
  });

  app.openapi(screenshotRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "previews.read", { type: "workspace", id: ws });
    const user = currentUser(c);
    const project = await getProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const link = await projectRunnerLink(projectDeps(deps), project, user.id);
    const raw = await runnerCall(link, "preview.screenshot", {
      workspace_id: ws,
      user_id: user.id,
      port: body.port,
      path: body.path,
      ...(body.width === undefined ? {} : { width: body.width }),
      ...(body.height === undefined ? {} : { height: body.height }),
    });
    const shot = screenshotResultSchema.parse(raw);
    const bytes = Buffer.from(shot.png, "base64");
    const name = `${project.key}-${body.port}${body.path.replace(/[^a-zA-Z0-9]+/g, "-")}.png`;
    const file = await storeUpload(
      { db: deps.db, env: { filesDir: deps.env.filesDir } },
      {
        workspaceId: ws,
        uploader: { type: "user", id: user.id },
        file: new File([bytes], name.replace(/-+/g, "-"), { type: "image/png" }),
      },
    );

    let messageId: string | null = null;
    if (body.channel_id) {
      // The caller's own view of the channel (spec §2.1): a private one they are not in is not
      // a place they can post a card, any more than a message.
      const channel = await channelFor(deps, ws, body.channel_id, user.id);
      const message = await insertMessage(deps.db.db, {
        workspaceId: ws,
        channelId: channel.id,
        threadRootId: body.thread_root_id ?? null,
        authorType: "user",
        authorId: user.id,
        blocks: [
          { type: "text", text: `${project.name} ${body.path}` },
          { type: "file", fileId: file.id },
        ],
      });
      messageId = message.id;
      await deps.bus.publish(
        "message.created",
        {
          workspaceId: ws,
          channelId: channel.id,
          messageId: message.id,
          ...(body.thread_root_id ? { threadRootId: body.thread_root_id } : {}),
          authorType: "user" as const,
          authorId: user.id,
        },
        { ...actorOf(c), topics: [`channel:${channel.id}`] },
      );
    }
    return c.json(
      {
        file_id: file.id,
        url: `/api/files/${file.id}`,
        width: shot.width,
        height: shot.height,
        message_id: messageId,
      },
      201,
    );
  });

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

  app.openapi(startRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const project = await getProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const state = await startPreview(previewRunDeps(deps), project, currentUser(c).id, actorOf(c));
    return c.json(state, 200);
  });

  app.openapi(stopRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const project = await getProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const state = await stopPreview(previewRunDeps(deps), project, currentUser(c).id, actorOf(c));
    return c.json(state, 200);
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
