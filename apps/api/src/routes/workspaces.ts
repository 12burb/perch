import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { AUDIT_ACTOR_TYPES, type AuditRow, workspaceSettingsSchema } from "@perch/db";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { findMembership } from "../repos/workspaces.ts";
import { type AuditQuery, EXPORT_LIMIT, toCsv } from "../services/audit.ts";
import { acceptInvite, createInvite, previewInvite } from "../services/invites.ts";
import {
  changeMemberRole,
  createWorkspace,
  getWorkspace,
  listMyWorkspaces,
  listWorkspaceMembers,
  removeMember,
  updateWorkspace,
} from "../services/workspaces.ts";
import {
  errorResponses,
  membershipRoleSchema,
  SESSION_OR_BEARER,
  workspaceBody,
  workspaceSchema,
} from "./shared.ts";

const myWorkspaceSchema = workspaceSchema
  .extend({ role: membershipRoleSchema })
  .openapi("MyWorkspace");

const workspaceDetailSchema = workspaceSchema
  .extend({ role: membershipRoleSchema, settings: workspaceSettingsSchema })
  .openapi("WorkspaceDetail");

const wsParam = z.object({ ws: z.uuid() });

const listWorkspaces = createRoute({
  method: "get",
  path: "/api/workspaces",
  tags: ["workspaces"],
  summary: "Workspaces the signed-in user belongs to",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  responses: {
    200: {
      description: "Memberships",
      content: {
        "application/json": { schema: z.object({ workspaces: z.array(myWorkspaceSchema) }) },
      },
    },
    ...errorResponses(403),
  },
});

const createWorkspaceRoute = createRoute({
  method: "post",
  path: "/api/workspaces",
  tags: ["workspaces"],
  summary: "Create a workspace; the creator becomes its owner",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              name: z.string().trim().min(1).max(80),
              slug: z.string().trim().min(1).max(40).optional(),
            })
            .openapi("WorkspaceCreate"),
        },
      },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: myWorkspaceSchema } } },
    ...errorResponses(403, 409, 422),
  },
});

const getWorkspaceRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}",
  tags: ["workspaces"],
  summary: "A workspace the caller belongs to",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "Workspace",
      content: { "application/json": { schema: workspaceDetailSchema } },
    },
    ...errorResponses(403, 404),
  },
});

const patchWorkspaceRoute = createRoute({
  method: "patch",
  path: "/api/workspaces/{ws}",
  tags: ["workspaces"],
  summary: "Update a workspace (owners and admins)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: wsParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              name: z.string().trim().min(1).max(80).optional(),
              slug: z.string().trim().min(1).max(40).optional(),
              settings: workspaceSettingsSchema.optional(),
            })
            .openapi("WorkspacePatch"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: workspaceDetailSchema } },
    },
    ...errorResponses(403, 404, 409, 422),
  },
});

const memberSchema = z
  .object({
    user_id: z.uuid(),
    name: z.string(),
    handle: z.string(),
    email: z.string(),
    avatar_file_id: z.uuid().nullable(),
    role: membershipRoleSchema,
    joined_at: z.string(),
  })
  .openapi("Member");

const listMembersRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/members",
  tags: ["workspaces"],
  summary: "Members of a workspace",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "Members",
      content: { "application/json": { schema: z.object({ members: z.array(memberSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const memberParam = z.object({ ws: z.uuid(), user: z.uuid() });

const patchMemberRoute = createRoute({
  method: "patch",
  path: "/api/workspaces/{ws}/members/{user}",
  tags: ["workspaces"],
  summary: "Change a member's role (owners and admins; only owners touch owners)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: memberParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({ role: membershipRoleSchema }).openapi("MemberRolePatch"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated",
      content: {
        "application/json": { schema: z.object({ user_id: z.uuid(), role: membershipRoleSchema }) },
      },
    },
    ...errorResponses(403, 404, 409, 422),
  },
});

const deleteMemberRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/members/{user}",
  tags: ["workspaces"],
  summary: "Remove a member, or leave (any member may remove themselves)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: memberParam },
  responses: {
    204: { description: "Removed" },
    ...errorResponses(403, 404, 409),
  },
});

/** The query string, as the service takes it. */
function auditQuery(query: {
  before?: string;
  limit?: number;
  action?: string;
  actor_type?: (typeof AUDIT_ACTOR_TYPES)[number];
  actor_id?: string;
  target_type?: string;
  from?: string;
  to?: string;
}): AuditQuery {
  return {
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.before ? { before: new Date(query.before) } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.actor_type ? { actorType: query.actor_type } : {}),
    ...(query.actor_id ? { actorId: query.actor_id } : {}),
    ...(query.target_type ? { targetType: query.target_type } : {}),
    ...(query.from ? { from: new Date(query.from) } : {}),
    ...(query.to ? { to: new Date(query.to) } : {}),
  };
}

/** What the audit page narrows by (task 4.5); every field is optional and they all AND. */
const auditQuerySchema = z.object({
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().min(1).max(64).optional(),
  actor_type: z.enum(AUDIT_ACTOR_TYPES).optional(),
  actor_id: z.uuid().optional(),
  target_type: z.string().min(1).max(64).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

const auditRowSchema = z
  .object({
    id: z.uuid(),
    ts: z.string(),
    actor_type: z.enum(["user", "bot", "system", "runner"]),
    actor_id: z.uuid().nullable(),
    action: z.string(),
    target_type: z.string(),
    target_id: z.uuid().nullable(),
    details: z.record(z.string(), z.unknown()),
    ip: z.string().nullable(),
  })
  .openapi("AuditRow");

const listAuditRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/audit",
  tags: ["workspaces"],
  summary: "The workspace audit log, newest first (owners and admins)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam, query: auditQuerySchema },
  responses: {
    200: {
      description: "Audit rows, and the actions this workspace has recorded",
      content: {
        "application/json": {
          schema: z.object({ rows: z.array(auditRowSchema), actions: z.array(z.string()) }),
        },
      },
    },
    ...errorResponses(403, 404, 422),
  },
});

const exportAuditRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/audit/export",
  tags: ["workspaces"],
  summary: "The same rows as CSV, for a spreadsheet or a compliance conversation",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: wsParam,
    query: auditQuerySchema.omit({ limit: true, before: true }),
  },
  responses: {
    200: {
      description: `At most ${EXPORT_LIMIT} rows, newest first`,
      content: { "text/csv": { schema: z.string() } },
    },
    ...errorResponses(403, 404, 422),
  },
});

const inviteSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    role: membershipRoleSchema,
    expires_at: z.string(),
    accept_url: z.string().openapi({
      description:
        "The accept link. Sent by email when PERCH_SMTP_URL is set; always returned to the inviter so it can be shared by hand.",
    }),
  })
  .openapi("InviteCreated");

const createInviteRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/invites",
  tags: ["workspaces"],
  summary: "Invite someone by email (owners and admins)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: wsParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ email: z.email(), role: membershipRoleSchema.default("member") })
            .openapi("InviteCreate"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Invite created",
      content: { "application/json": { schema: inviteSchema } },
    },
    ...errorResponses(403, 404, 422),
  },
});

const invitePreviewSchema = z
  .object({
    workspace: z.object({ id: z.uuid(), name: z.string(), slug: z.string() }),
    email: z.string().openapi({ description: "Masked" }),
    role: membershipRoleSchema,
    expires_at: z.string(),
    status: z.enum(["pending", "accepted", "expired"]),
  })
  .openapi("InvitePreview");

const previewInviteRoute = createRoute({
  method: "get",
  path: "/api/invites/{token}",
  tags: ["workspaces"],
  summary: "Preview an invite before signing in",
  request: { params: z.object({ token: z.string().min(8) }) },
  responses: {
    200: {
      description: "Invite",
      content: { "application/json": { schema: invitePreviewSchema } },
    },
    ...errorResponses(404),
  },
});

const acceptInviteRoute = createRoute({
  method: "post",
  path: "/api/invites/{token}/accept",
  tags: ["workspaces"],
  summary: "Accept an invite as the signed-in user",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: z.object({ token: z.string().min(8) }) },
  responses: {
    200: { description: "Joined", content: { "application/json": { schema: myWorkspaceSchema } } },
    ...errorResponses(403, 404, 409),
  },
});

export function registerWorkspaces(
  app: OpenAPIHono<AppEnv>,
  deps: Pick<Deps, "db" | "bus" | "env" | "audit">,
): void {
  app.openapi(listWorkspaces, async (c) => {
    const user = currentUser(c);
    const rows = await listMyWorkspaces(deps.db.db, user.id);
    return c.json(
      { workspaces: rows.map((r) => ({ ...workspaceBody(r.workspace), role: r.role })) },
      200,
    );
  });

  app.openapi(createWorkspaceRoute, async (c) => {
    const body = c.req.valid("json");
    const workspace = await createWorkspace(deps.db.db, deps.bus, {
      name: body.name,
      ...(body.slug ? { slug: body.slug } : {}),
      by: actorOf(c),
    });
    c.set("workspaceId", workspace.id);
    return c.json({ ...workspaceBody(workspace), role: "owner" as const }, 201);
  });

  app.openapi(getWorkspaceRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const { role } = await authorize(c, deps, "workspace.read", { type: "workspace", id: ws });
    const workspace = await getWorkspace(deps.db.db, ws);
    return c.json({ ...workspaceBody(workspace), role, settings: workspace.settings }, 200);
  });

  app.openapi(patchWorkspaceRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const { role } = await authorize(c, deps, "workspace.update", { type: "workspace", id: ws });
    const workspace = await updateWorkspace(deps.db.db, deps.bus, {
      workspaceId: ws,
      patch: c.req.valid("json"),
      by: actorOf(c),
    });
    return c.json({ ...workspaceBody(workspace), role, settings: workspace.settings }, 200);
  });

  app.openapi(listMembersRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "members.read", { type: "workspace", id: ws });
    const rows = await listWorkspaceMembers(deps.db.db, ws);
    return c.json(
      {
        members: rows.map((r) => ({
          user_id: r.user.id,
          name: r.user.name,
          handle: r.user.handle,
          email: r.user.email,
          avatar_file_id: r.user.avatarFileId,
          role: r.membership.role,
          joined_at: r.membership.createdAt.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi(patchMemberRoute, async (c) => {
    const { ws, user } = c.req.valid("param");
    const { role: newRole } = c.req.valid("json");
    const target = await memberResource(deps, ws, user, newRole);
    await authorize(c, deps, "members.update_role", target);
    const role = await changeMemberRole(deps.db.db, deps.bus, {
      workspaceId: ws,
      userId: user,
      role: newRole,
      by: actorOf(c),
    });
    return c.json({ user_id: user, role }, 200);
  });

  app.openapi(deleteMemberRoute, async (c) => {
    const { ws, user } = c.req.valid("param");
    const target = await memberResource(deps, ws, user);
    await authorize(c, deps, "members.remove", target);
    await removeMember(deps.db.db, deps.bus, { workspaceId: ws, userId: user, by: actorOf(c) });
    return c.body(null, 204);
  });

  app.openapi(listAuditRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const query = c.req.valid("query");
    await authorize(c, deps, "audit.read", { type: "workspace", id: ws });
    const [rows, actions] = await Promise.all([
      deps.audit.list(ws, auditQuery(query)),
      deps.audit.actions(ws),
    ]);
    return c.json(
      {
        rows: rows.map((r: AuditRow) => ({
          id: r.id,
          ts: r.ts.toISOString(),
          actor_type: r.actorType,
          actor_id: r.actorId,
          action: r.action,
          target_type: r.targetType,
          target_id: r.targetId,
          details: r.details,
          ip: r.ip,
        })),
        actions,
      },
      200,
    );
  });

  app.openapi(exportAuditRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const query = c.req.valid("query");
    await authorize(c, deps, "audit.read", { type: "workspace", id: ws });
    const rows = await deps.audit.export(ws, auditQuery(query));
    // A download rather than something a browser renders: the name carries the day it was taken.
    const day = new Date().toISOString().slice(0, 10);
    return c.body(toCsv(rows), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="perch-audit-${day}.csv"`,
    });
  });

  app.openapi(createInviteRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    const { role } = await authorize(c, deps, "members.invite", { type: "workspace", id: ws });
    const created = await createInvite(deps.db.db, {
      workspaceId: ws,
      email: body.email,
      role: body.role,
      inviterRole: role,
      publicUrl: deps.env.publicUrl,
    });
    c.get("log").info({ email: body.email, url: created.acceptUrl }, "invite link");
    return c.json(
      {
        id: created.invite.id,
        email: created.invite.email,
        role: created.invite.role,
        expires_at: created.invite.expiresAt.toISOString(),
        accept_url: created.acceptUrl,
      },
      201,
    );
  });

  app.openapi(previewInviteRoute, async (c) => {
    const preview = await previewInvite(deps.db.db, c.req.valid("param").token);
    return c.json({ ...preview, expires_at: preview.expiresAt.toISOString() }, 200);
  });

  app.openapi(acceptInviteRoute, async (c) => {
    const user = currentUser(c);
    const joined = await acceptInvite(deps.db.db, deps.bus, {
      token: c.req.valid("param").token,
      user,
      by: actorOf(c),
    });
    c.set("workspaceId", joined.workspace.id);
    return c.json({ ...workspaceBody(joined.workspace), role: joined.role }, 200);
  });
}

/** The member resource for authorize(): the target's current role, hidden behind not_found when absent. */
async function memberResource(
  deps: Pick<Deps, "db">,
  workspaceId: string,
  userId: string,
  newRole?: "owner" | "admin" | "member",
) {
  const membership = await findMembership(deps.db.db, workspaceId, userId);
  return {
    type: "member" as const,
    workspaceId,
    userId,
    role: membership?.role ?? ("member" as const),
    ...(newRole ? { newRole } : {}),
  };
}
