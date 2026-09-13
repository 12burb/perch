import type { Bus } from "@perch/bus";
import type { Db, MembershipRole, Workspace } from "@perch/db";
import { PerchError } from "../errors.ts";
import {
  findMembership,
  findWorkspaceBySlug,
  insertMembership,
  insertWorkspace,
  listWorkspacesForUser,
} from "../repos/workspaces.ts";

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

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
  if (!(await findWorkspaceBySlug(db, base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 40 - String(i).length - 1)}-${i}`;
    if (!(await findWorkspaceBySlug(db, candidate))) return candidate;
  }
  return `${base.slice(0, 30)}-${Bun.randomUUIDv7().slice(-8)}`;
}

export async function createWorkspace(
  db: Db,
  bus: Bus,
  input: { userId: string; name: string; slug?: string },
): Promise<Workspace> {
  const requested = input.slug ?? slugify(input.name);
  if (!SLUG_PATTERN.test(requested)) {
    throw PerchError.validation("slug must be 1-40 lowercase letters, digits, or dashes");
  }
  // An explicit slug must be free; a slug derived from the name gets a numeric suffix instead.
  const slug = input.slug ? requested : await uniqueSlug(db, requested);
  if (await findWorkspaceBySlug(db, slug)) throw PerchError.conflict("slug is taken", { slug });
  const workspace = await insertWorkspace(db, { slug, name: input.name.trim() });
  await insertMembership(db, { workspaceId: workspace.id, userId: input.userId, role: "owner" });
  await bus.publish(
    "member.added",
    { workspaceId: workspace.id, userId: input.userId, role: "owner" },
    { actor: { type: "user", id: input.userId } },
  );
  return workspace;
}

export function listMyWorkspaces(db: Db, userId: string) {
  return listWorkspacesForUser(db, userId);
}

/** The caller's role in a workspace, or a not_found error (a non-member cannot tell it exists). */
export async function requireMembership(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<MembershipRole> {
  const membership = await findMembership(db, workspaceId, userId);
  if (!membership) throw PerchError.notFound("workspace");
  return membership.role;
}
