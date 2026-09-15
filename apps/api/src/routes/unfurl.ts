/**
 * Unfurls (spec §1, §5.2; task 2.3): `POST /api/workspaces/{ws}/unfurl` turns the identifiers in a
 * message into cards the client can draw beside it.
 *
 * It is a POST because the client asks about a handful of identifiers at once and they are the
 * caller's own text, not a URL to cache. Nothing comes back that the caller could not have opened.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { MAX_IDENTIFIERS, UNFURL_KINDS, unfurl } from "../services/unfurl.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const cardSchema = z
  .object({
    identifier: z.string(),
    kind: z.enum(UNFURL_KINDS),
    title: z.string(),
    subtitle: z.string().nullable(),
    url: z.string(),
  })
  .openapi("UnfurlCard");

const unfurlRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/unfurl",
  tags: ["messages"],
  summary: "What the identifiers in a message point at",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: z.object({ ws: z.uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              identifiers: z.array(z.string().min(1).max(200)).max(MAX_IDENTIFIERS),
            })
            .openapi("UnfurlRequest"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "A card for every identifier the caller may see",
      content: { "application/json": { schema: z.object({ cards: z.array(cardSchema) }) } },
    },
    ...errorResponses(403, 404, 422),
  },
});

export function registerUnfurl(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.openapi(unfurlRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const { identifiers } = c.req.valid("json");
    await authorize(c, deps, "workspace.read", { type: "workspace", id: ws });
    const cards = await unfurl(deps, { workspaceId: ws, userId: currentUser(c).id }, identifiers);
    return c.json({ cards }, 200);
  });
}
