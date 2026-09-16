/**
 * Spec bots over REST (spec §5.3, §7.1 `.../projects`; task 3.1).
 *
 * One route: read this project's `bots/` again and make the workspace match. It is here rather
 * than under `.../bots` because the repository is what changed, and the project is what has a
 * runner to read it on.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { getProject, projectRunnerLink } from "../services/projects.ts";
import { projectDeps } from "./projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const syncSchema = z
  .object({
    added: z.array(z.string()),
    updated: z.array(z.string()),
    removed: z.array(z.string()),
    /** A directory Perch could not read, and why. The rest of the repository still synced. */
    failed: z.array(z.object({ handle: z.string(), error: z.string() })),
  })
  .openapi("SpecBotSync");

const reloadRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/bots/reload",
  tags: ["bots"],
  summary: "Read this project's bots/ again and make the workspace match",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: z.object({ ws: z.uuid(), project: z.uuid() }) },
  responses: {
    200: {
      description: "What the sync did",
      content: { "application/json": { schema: syncSchema } },
    },
    ...errorResponses(403, 404, 409),
  },
});

export function registerSpecBots(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.openapi(reloadRoute, async (c) => {
    const { ws, project: id } = c.req.valid("param");
    // Syncing writes bots, so it is the bots permission rather than the project's.
    await authorize(c, deps, "bots.write", { type: "workspace", id: ws });
    const project = await getProject(deps.db.db, ws, id);
    if (!project) throw PerchError.notFound("project");
    const user = currentUser(c);
    const link = await projectRunnerLink(projectDeps(deps), project, user.id);
    return c.json(await deps.specBots.sync(link, project, user.id), 200);
  });
}
