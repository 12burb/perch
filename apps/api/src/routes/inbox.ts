/**
 * The inbox over REST (spec §7.1 `/api/inbox?status`, `/api/inbox/{id}/resolve|snooze`; task 2.10).
 *
 * An inbox is one person's, across every workspace they are in — what needs them is what needs
 * them, wherever it happened — so these paths carry no workspace and no policy decision beyond
 * "this is yours". Acting on the thing itself happens on the thing's own route; what the inbox
 * does is say what is waiting, and let somebody put it away.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { INBOX_KINDS, INBOX_STATUSES, type InboxItem } from "@perch/db";
import { currentUser, requireUser } from "../auth/middleware.ts";
import { boundWorkspace, tokenGate } from "../auth/token-gate.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { getItem, listItems, setStatus } from "../repos/inbox.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const itemSchema = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    kind: z.enum(INBOX_KINDS),
    ref_type: z.string(),
    ref_id: z.string(),
    status: z.enum(INBOX_STATUSES),
    title: z.string(),
    body: z.string(),
    /** Where to go to deal with it, as a path in this Perch. */
    url: z.string().nullable(),
    snoozed_until: z.string().nullable(),
    resolved_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("InboxItem");

const itemsSchema = z
  .object({ items: z.array(itemSchema), open: z.number().int() })
  .openapi("InboxItems");

const snoozeBody = z
  .object({
    /** When it should come back. Without one it sleeps until somebody wakes it. */
    until: z.iso.datetime().optional(),
  })
  .openapi("SnoozeInboxItem");

const listRoute = createRoute({
  method: "get",
  path: "/api/inbox",
  tags: ["inbox"],
  summary: "What needs you",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    query: z.object({
      status: z.enum([...INBOX_STATUSES, "all"]).optional(),
      kind: z.enum(INBOX_KINDS).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: { description: "The queue", content: { "application/json": { schema: itemsSchema } } },
    ...errorResponses(403),
  },
});

const resolveRoute = createRoute({
  method: "post",
  path: "/api/inbox/{id}/resolve",
  tags: ["inbox"],
  summary: "Put one away",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "The item", content: { "application/json": { schema: itemSchema } } },
    ...errorResponses(403, 404),
  },
});

const snoozeRoute = createRoute({
  method: "post",
  path: "/api/inbox/{id}/snooze",
  tags: ["inbox"],
  summary: "Come back to it later",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { "application/json": { schema: snoozeBody } } },
  },
  responses: {
    200: { description: "The item", content: { "application/json": { schema: itemSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

function body(row: InboxItem) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    kind: row.kind,
    ref_type: row.refType,
    ref_id: row.refId,
    status: row.status,
    title: row.payload.title ?? "",
    body: row.payload.body ?? "",
    url: row.payload.url ?? null,
    snoozed_until: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
    resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

export function registerInbox(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  /**
   * An item is its owner's; to anybody else it is not there at all. A token bound to one workspace
   * sees that workspace's items only, and the same not_found for the rest (ADR-0172).
   */
  const mine = async (c: Parameters<typeof tokenGate>[0], id: string): Promise<InboxItem> => {
    tokenGate(c, "write");
    const item = await getItem(deps.db.db, id);
    if (!item || item.userId !== currentUser(c).id) throw PerchError.notFound("inbox item");
    const bound = boundWorkspace(c);
    if (bound !== undefined && item.workspaceId !== bound) throw PerchError.notFound("inbox item");
    return item;
  };

  app.openapi(listRoute, async (c) => {
    const { status, kind, limit } = c.req.valid("query");
    const user = currentUser(c);
    tokenGate(c, "read");
    const bound = boundWorkspace(c);
    const scope = bound === undefined ? {} : { workspaceId: bound };
    const items = await listItems(deps.db.db, user.id, {
      ...scope,
      ...(status ? { status } : {}),
      ...(kind ? { kinds: [kind] } : {}),
      ...(limit ? { limit } : {}),
    });
    // The count is what the rail's badge and the phone's launch tab read (spec §4).
    const open =
      status === undefined || status === "open"
        ? items.length
        : (await listItems(deps.db.db, user.id, { ...scope, status: "open", limit: 200 })).length;
    return c.json({ items: items.map(body), open }, 200);
  });

  app.openapi(resolveRoute, async (c) => {
    const { id } = c.req.valid("param");
    const item = await mine(c, id);
    const saved = await setStatus(deps.db.db, item.id, {
      status: "resolved",
      resolvedAt: new Date(),
    });
    if (!saved) throw PerchError.notFound("inbox item");
    await deps.bus.publish(
      "inbox.resolved",
      { workspaceId: saved.workspaceId, userId: saved.userId, inboxItemId: saved.id },
      { actor: { type: "user", id: saved.userId }, topics: [`inbox:${saved.userId}`] },
    );
    return c.json(body(saved), 200);
  });

  app.openapi(snoozeRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { until } = c.req.valid("json");
    const item = await mine(c, id);
    const when = until ? new Date(until) : null;
    if (when && when.getTime() <= Date.now()) {
      throw PerchError.validation("a snooze has to be in the future");
    }
    const saved = await setStatus(deps.db.db, item.id, {
      status: "snoozed",
      snoozedUntil: when,
      resolvedAt: null,
    });
    if (!saved) throw PerchError.notFound("inbox item");
    return c.json(body(saved), 200);
  });
}
