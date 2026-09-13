import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { acceptInvite, createInvite, previewInvite } from "../services/invites.ts";
import { createWorkspace, listMyWorkspaces } from "../services/workspaces.ts";
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
    params: z.object({ ws: z.uuid() }),
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
  deps: Pick<Deps, "db" | "bus" | "env">,
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
    const user = currentUser(c);
    const body = c.req.valid("json");
    const workspace = await createWorkspace(deps.db.db, deps.bus, {
      userId: user.id,
      name: body.name,
      ...(body.slug ? { slug: body.slug } : {}),
    });
    c.set("workspaceId", workspace.id);
    return c.json({ ...workspaceBody(workspace), role: "owner" as const }, 201);
  });

  app.openapi(createInviteRoute, async (c) => {
    const user = currentUser(c);
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    c.set("workspaceId", ws);
    const created = await createInvite(deps.db.db, {
      workspaceId: ws,
      email: body.email,
      role: body.role,
      invitedBy: user,
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
    });
    c.set("workspaceId", joined.workspace.id);
    return c.json({ ...workspaceBody(joined.workspace), role: joined.role }, 200);
  });
}
