import type { Bus } from "@perch/bus";
import type { Db, Invite, MembershipRole, User, Workspace } from "@perch/db";
import { PerchError } from "../errors.ts";
import { findInviteByHash, insertInvite, markInviteAccepted } from "../repos/invites.ts";
import { findMembership, findWorkspaceById, insertMembership } from "../repos/workspaces.ts";
import { hashToken } from "./tokens.ts";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function randomInviteToken(): string {
  return `inv_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;
}

export type CreatedInvite = { invite: Invite; token: string; acceptUrl: string };

/** Owners and admins invite by email; the accept link is returned to the inviter and logged (console transport). */
export async function createInvite(
  db: Db,
  input: {
    workspaceId: string;
    email: string;
    role: MembershipRole;
    invitedBy: User;
    publicUrl: string;
    now?: Date;
  },
): Promise<CreatedInvite> {
  const membership = await findMembership(db, input.workspaceId, input.invitedBy.id);
  if (!membership) throw PerchError.notFound("workspace");
  if (membership.role === "member") throw PerchError.forbidden("only owners and admins can invite");
  if (input.role === "owner" && membership.role !== "owner") {
    throw PerchError.forbidden("only an owner can invite another owner");
  }
  const token = randomInviteToken();
  const now = input.now ?? new Date();
  const invite = await insertInvite(db, {
    workspaceId: input.workspaceId,
    email: input.email.trim(),
    role: input.role,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
  });
  return { invite, token, acceptUrl: `${input.publicUrl}/invite/${token}` };
}

export type InvitePreview = {
  workspace: Pick<Workspace, "id" | "name" | "slug">;
  email: string;
  role: MembershipRole;
  expiresAt: Date;
  status: "pending" | "accepted" | "expired";
};

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const shown = local.slice(0, 1);
  return `${shown}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
}

export async function previewInvite(
  db: Db,
  token: string,
  now = new Date(),
): Promise<InvitePreview> {
  const invite = await findInviteByHash(db, hashToken(token));
  if (!invite) throw PerchError.notFound("invite");
  const workspace = await findWorkspaceById(db, invite.workspaceId);
  if (!workspace) throw PerchError.notFound("workspace");
  const status = invite.acceptedAt ? "accepted" : invite.expiresAt < now ? "expired" : "pending";
  return {
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    email: maskEmail(invite.email),
    role: invite.role,
    expiresAt: invite.expiresAt,
    status,
  };
}

/** Accepting binds the invite to the signed-in user whose email matches; membership is created once. */
export async function acceptInvite(
  db: Db,
  bus: Bus,
  input: { token: string; user: User; now?: Date },
): Promise<{ workspace: Workspace; role: MembershipRole }> {
  const now = input.now ?? new Date();
  const invite = await findInviteByHash(db, hashToken(input.token));
  if (!invite) throw PerchError.notFound("invite");
  if (invite.acceptedAt) throw PerchError.conflict("invite already accepted");
  if (invite.expiresAt < now) throw PerchError.conflict("invite expired");
  if (invite.email.toLowerCase() !== input.user.email.toLowerCase()) {
    throw PerchError.forbidden("this invite was sent to a different email address");
  }
  const workspace = await findWorkspaceById(db, invite.workspaceId);
  if (!workspace) throw PerchError.notFound("workspace");
  const created = await insertMembership(db, {
    workspaceId: workspace.id,
    userId: input.user.id,
    role: invite.role,
  });
  await markInviteAccepted(db, invite.id, now);
  if (created) {
    await bus.publish(
      "member.added",
      { workspaceId: workspace.id, userId: input.user.id, role: invite.role },
      { actor: { type: "user", id: input.user.id } },
    );
  }
  return { workspace, role: invite.role };
}
