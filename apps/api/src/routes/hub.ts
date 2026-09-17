/**
 * The Hub over REST (task 4.12).
 *
 * `GET /api/hub` is a catalogue: the same for every workspace and every instance, because it is
 * built from what this commit ships, so it is signed in to read and nothing to authorize against —
 * the same shape as `/api/templates` (task 4.8).
 *
 * `POST /api/workspaces/{ws}/hub/install` is the half that changes something, and it is authorized
 * as whatever it is about to do: a bot install needs `bots.create`, a template needs
 * `projects.create`, a skill needs `bots.update`. Nothing here has a permission of its own.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type catalog, HUB_KINDS, hubCounts, searchHub } from "@perch/hub";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { findWorkspaceById } from "../repos/workspaces.ts";
import { hubDepsFrom, installFromHub } from "../services/hub.ts";
import { projectDeps } from "./projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const hubItemSchema = z
  .object({
    kind: z.enum(HUB_KINDS),
    id: z.string(),
    name: z.string(),
    blurb: z.string(),
    /** What pressing Install does, in a sentence. */
    installs: z.string(),
    tags: z.array(z.string()),
    /** Where in this build it came from. */
    from: z.string(),
    handle: z.string().optional(),
    parent: z.string().optional(),
    auth: z.array(z.string()).optional(),
    docs_url: z.string().optional(),
    port: z.number().int().optional(),
  })
  .openapi("HubItem");

const installResultSchema = z
  .object({
    item: hubItemSchema,
    /** False when there was nothing to do — it is already here, or it needs a person. */
    installed: z.boolean(),
    detail: z.string(),
    href: z.string().optional(),
    bot_id: z.uuid().optional(),
    project_id: z.uuid().optional(),
  })
  .openapi("HubInstall");

const listRoute = createRoute({
  method: "get",
  path: "/api/hub",
  tags: ["hub"],
  summary: "Everything this build ships that a workspace can take on",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    query: z.object({
      kind: z.enum(HUB_KINDS).optional(),
      q: z.string().max(200).optional(),
    }),
  },
  responses: {
    200: {
      description: "The index",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(hubItemSchema),
            /** How many of each kind the whole index has, whatever the filter. */
            counts: z.record(z.enum(HUB_KINDS), z.number().int()),
          }),
        },
      },
    },
    ...errorResponses(403),
  },
});

const installRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/hub/install",
  tags: ["hub"],
  summary: "Take one Hub item on in this workspace",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: z.object({ ws: z.uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            kind: z.enum(HUB_KINDS),
            id: z.string().min(1).max(120),
            /** For a skill: the bot handle it goes on. */
            bot: z.string().min(1).max(64).optional(),
            /** For a bot: a channel to put it in as well. */
            channel: z.uuid().optional(),
            /** For a template: what the project is called. */
            name: z.string().min(1).max(120).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "What happened",
      content: { "application/json": { schema: installResultSchema } },
    },
    ...errorResponses(403, 404, 409, 422),
  },
});

/** The action a kind's install performs, which is what it is authorized as. */
const ACTION = {
  connector: "connections.read",
  bot: "bots.write",
  skill: "bots.write",
  template: "projects.create",
} as const;

function itemBody(item: (typeof catalog extends () => infer R ? R : never)[number]) {
  return {
    kind: item.kind,
    id: item.id,
    name: item.name,
    blurb: item.blurb,
    installs: item.installs,
    tags: item.tags,
    from: item.from,
    ...(item.handle ? { handle: item.handle } : {}),
    ...(item.parent ? { parent: item.parent } : {}),
    ...(item.auth ? { auth: item.auth } : {}),
    ...(item.docsUrl ? { docs_url: item.docsUrl } : {}),
    ...(item.port ? { port: item.port } : {}),
  };
}

export function registerHub(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.openapi(listRoute, (c) => {
    const { kind, q } = c.req.valid("query");
    const items = searchHub({ ...(kind ? { kind } : {}), ...(q ? { q } : {}) });
    return c.json({ items: items.map(itemBody), counts: hubCounts() }, 200);
  });

  app.openapi(installRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, ACTION[body.kind], { type: "workspace", id: ws });
    const workspace = await findWorkspaceById(deps.db.db, ws);
    if (!workspace) throw PerchError.notFound("workspace");
    const user = currentUser(c);
    const result = await installFromHub(
      hubDepsFrom(projectDeps(deps), deps.bots),
      {
        workspaceId: ws,
        userId: user.id,
        kind: body.kind,
        id: body.id,
        bot: body.bot,
        channel: body.channel,
        name: body.name,
        by: actorOf(c),
      },
      workspace.slug,
    );
    return c.json(
      {
        item: itemBody(result.item),
        installed: result.installed,
        detail: result.detail,
        ...(result.href ? { href: result.href } : {}),
        ...(result.botId ? { bot_id: result.botId } : {}),
        ...(result.projectId ? { project_id: result.projectId } : {}),
      },
      200,
    );
  });
}
