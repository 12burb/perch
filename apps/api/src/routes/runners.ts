/**
 * Runners of a workspace (spec §3.2, task 1.3): the Environments page lists them with live status, a
 * member connects a machine of their own (a local runner row and its connect token, shown once), and
 * a runner's owner or a workspace admin removes it.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { findRunnerById } from "../repos/runners.ts";
import {
  connectCommand,
  connectOwnRunner,
  listRunnersForWorkspace,
  type RunnerView,
  removeRunner,
} from "../services/runners.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const wsParam = z.object({ ws: z.uuid() });
const runnerParam = z.object({ ws: z.uuid(), runner: z.uuid() });

export const runnerSchema = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid().nullable(),
    kind: z.enum(["hosted", "local", "remote"]),
    name: z.string(),
    status: z.string(),
    owner_user_id: z.uuid().nullable(),
    connected: z.boolean(),
    load: z.object({ cpu: z.number().optional(), memoryMb: z.number().optional() }),
    sessions: z.number().int(),
    platform: z.string().nullable(),
    arch: z.string().nullable(),
    last_seen_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Runner");

function runnerBody(view: RunnerView): z.infer<typeof runnerSchema> {
  return {
    id: view.id,
    workspace_id: view.workspaceId,
    kind: view.kind,
    name: view.name,
    status: view.status,
    owner_user_id: view.ownerUserId,
    connected: view.connected,
    load: view.load,
    sessions: view.sessions,
    platform: view.capabilities.platform ?? null,
    arch: view.capabilities.arch ?? null,
    last_seen_at: view.lastSeenAt?.toISOString() ?? null,
    created_at: view.createdAt.toISOString(),
  };
}

const listRunnersRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/runners",
  tags: ["runners"],
  summary: "Runners a workspace may use, with live status",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "Runners",
      content: { "application/json": { schema: z.object({ runners: z.array(runnerSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const connectRunnerRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/runners/connect",
  tags: ["runners"],
  summary: "Register a machine of your own and mint its connect token (shown once)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: wsParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().trim().min(1).max(80),
            kind: z.enum(["local", "remote"]).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "The runner, its connect token, and the command to run",
      content: {
        "application/json": {
          schema: z.object({ runner: runnerSchema, token: z.string(), command: z.string() }),
        },
      },
    },
    ...errorResponses(403, 404, 422),
  },
});

const deleteRunnerRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/runners/{runner}",
  tags: ["runners"],
  summary: "Remove a runner (its owner, or a workspace admin)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: runnerParam },
  responses: { 204: { description: "Removed" }, ...errorResponses(403, 404) },
});

export function registerRunners(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.openapi(listRunnersRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "runners.read", { type: "workspace", id: ws });
    const runners = await listRunnersForWorkspace(deps.db.db, deps.runners, ws);
    return c.json({ runners: runners.map(runnerBody) }, 200);
  });

  app.openapi(connectRunnerRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "runners.connect", { type: "workspace", id: ws });
    const user = currentUser(c);
    const { runner, token } = await connectOwnRunner(deps.db.db, {
      workspaceId: ws,
      ownerUserId: user.id,
      name: body.name,
      kind: body.kind,
    });
    const [view] = (await listRunnersForWorkspace(deps.db.db, deps.runners, ws)).filter(
      (r) => r.id === runner.id,
    );
    if (!view) throw PerchError.notFound("runner");
    return c.json(
      {
        runner: runnerBody(view),
        token,
        command: connectCommand(deps.env.publicUrl, token, runner.name),
      },
      201,
    );
  });

  app.openapi(deleteRunnerRoute, async (c) => {
    const { ws, runner: runnerId } = c.req.valid("param");
    const user = currentUser(c);
    const runner = await findRunnerById(deps.db.db, runnerId);
    if (!runner || (runner.workspaceId !== null && runner.workspaceId !== ws)) {
      await authorize(c, deps, "runners.read", { type: "workspace", id: ws });
      throw PerchError.notFound("runner");
    }
    // Your own machine, or an admin's call on anyone's.
    if (runner.ownerUserId === user.id) {
      await authorize(c, deps, "runners.read", { type: "workspace", id: ws });
    } else {
      await authorize(c, deps, "runners.remove", { type: "workspace", id: ws });
    }
    await removeRunner(deps.db.db, deps.runners, runner.id);
    return c.body(null, 204);
  });
}
