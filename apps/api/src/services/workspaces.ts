import type { Bus } from "@perch/bus";
import type { Db, MembershipRole, Workspace, WorkspaceSettings } from "@perch/db";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import {
  countOwners,
  deleteMembership,
  findMembership,
  findWorkspaceById,
  findWorkspaceBySlug,
  insertMembership,
  insertWorkspace,
  listMembers,
  listWorkspacesForUser,
  updateMembershipRole,
  updateWorkspace as updateWorkspaceRow,
} from "../repos/workspaces.ts";

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Slugs a workspace cannot have, because a path of that name is already something else: the web
 * app's top-level routes (a workspace at `/settings` or `/welcome` would be shadowed by the route,
 * or taken for it) and the prefixes the server keeps for itself (`isReservedPath`, `/assets`).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "settings",
  "welcome",
  "connections",
  "setup",
  "sign-in",
  "sign-up",
  "invite",
  "api",
  "p",
  "hooks",
  "mcp",
  "v1",
  "assets",
]);

/** A slug a workspace may have: the pattern, and not a path the app already uses. */
function checkSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw PerchError.validation("slug must be 1-40 lowercase letters, digits, or dashes");
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw PerchError.validation("slug is reserved: a page of Perch already has that path", {
      slug,
    });
  }
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length >= 1 ? slug : "workspace";
}

async function uniqueSlug(db: Db, base: string): Promise<string> {
  // A reserved slug is as good as taken: the name "Settings" becomes `settings-2`.
  if (!RESERVED_SLUGS.has(base) && !(await findWorkspaceBySlug(db, base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 40 - String(i).length - 1)}-${i}`;
    if (!(await findWorkspaceBySlug(db, candidate))) return candidate;
  }
  return `${base.slice(0, 30)}-${Bun.randomUUIDv7().slice(-8)}`;
}

export async function createWorkspace(
  db: Db,
  bus: Bus,
  input: { name: string; slug?: string; by: ActorContext },
): Promise<Workspace> {
  const userId = input.by.actor.id;
  if (!userId) throw PerchError.forbidden("authentication required");
  const requested = input.slug ?? slugify(input.name);
  if (input.slug) checkSlug(requested);
  else if (!SLUG_PATTERN.test(requested)) {
    throw PerchError.validation("slug must be 1-40 lowercase letters, digits, or dashes");
  }
  // An explicit slug must be free; a slug derived from the name gets a numeric suffix instead.
  const slug = input.slug ? requested : await uniqueSlug(db, requested);
  if (await findWorkspaceBySlug(db, slug)) throw PerchError.conflict("slug is taken", { slug });
  const workspace = await insertWorkspace(db, { slug, name: input.name.trim() });
  await insertMembership(db, { workspaceId: workspace.id, userId, role: "owner" });
  await bus.publish("member.added", { workspaceId: workspace.id, userId, role: "owner" }, input.by);
  return workspace;
}

export function listMyWorkspaces(db: Db, userId: string) {
  return listWorkspacesForUser(db, userId);
}

export async function getWorkspace(db: Db, workspaceId: string): Promise<Workspace> {
  const workspace = await findWorkspaceById(db, workspaceId);
  if (!workspace) throw PerchError.notFound("workspace");
  return workspace;
}

export async function updateWorkspace(
  db: Db,
  bus: Bus,
  input: {
    workspaceId: string;
    patch: { name?: string; slug?: string; settings?: WorkspaceSettings };
    by: ActorContext;
  },
): Promise<Workspace> {
  const patch: Partial<{ name: string; slug: string; settings: WorkspaceSettings }> = {};
  if (input.patch.name !== undefined) patch.name = input.patch.name.trim();
  if (input.patch.settings !== undefined) patch.settings = input.patch.settings;
  if (input.patch.slug !== undefined) {
    checkSlug(input.patch.slug);
    const holder = await findWorkspaceBySlug(db, input.patch.slug);
    if (holder && holder.id !== input.workspaceId) {
      throw PerchError.conflict("slug is taken", { slug: input.patch.slug });
    }
    patch.slug = input.patch.slug;
  }
  const changes = Object.keys(patch);
  const current = await getWorkspace(db, input.workspaceId);
  if (changes.length === 0) return current;
  const updated = await updateWorkspaceRow(db, input.workspaceId, patch);
  if (!updated) throw PerchError.notFound("workspace");
  await bus.publish("workspace.updated", { workspaceId: updated.id, changes }, input.by);
  return updated;
}

export function listWorkspaceMembers(db: Db, workspaceId: string) {
  return listMembers(db, workspaceId);
}

/** Changes a member's role. The last owner cannot be demoted (the workspace would be orphaned). */
export async function changeMemberRole(
  db: Db,
  bus: Bus,
  input: { workspaceId: string; userId: string; role: MembershipRole; by: ActorContext },
): Promise<MembershipRole> {
  const membership = await findMembership(db, input.workspaceId, input.userId);
  if (!membership) throw PerchError.notFound("member");
  if (membership.role === input.role) return membership.role;
  if (membership.role === "owner" && (await countOwners(db, input.workspaceId)) <= 1) {
    throw PerchError.conflict("a workspace needs at least one owner", { reason: "last_owner" });
  }
  const updated = await updateMembershipRole(db, input.workspaceId, input.userId, input.role);
  if (!updated) throw PerchError.notFound("member");
  await bus.publish(
    "member.role_changed",
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      previousRole: membership.role,
    },
    input.by,
  );
  return updated.role;
}

/** Removes a member (or lets one leave). The last owner cannot be removed. */
export async function removeMember(
  db: Db,
  bus: Bus,
  input: { workspaceId: string; userId: string; by: ActorContext },
): Promise<void> {
  const membership = await findMembership(db, input.workspaceId, input.userId);
  if (!membership) throw PerchError.notFound("member");
  if (membership.role === "owner" && (await countOwners(db, input.workspaceId)) <= 1) {
    throw PerchError.conflict("a workspace needs at least one owner", { reason: "last_owner" });
  }
  await deleteMembership(db, input.workspaceId, input.userId);
  await bus.publish(
    "member.removed",
    { workspaceId: input.workspaceId, userId: input.userId },
    input.by,
  );
}
