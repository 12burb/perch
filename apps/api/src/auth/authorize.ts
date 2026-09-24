/**
 * authorize() in every handler (spec §9.1): resolves the caller's membership in the resource's
 * workspace, applies the @perch/policy decision, and turns a denial into the §7.8 error. Non-members get
 * `not_found` so a workspace's existence is never revealed (task 0.9: "member cannot read another
 * workspace").
 */
import type { Actor, EventMeta } from "@perch/events";
import {
  type Action,
  type AuthzContext,
  authorize as decide,
  type Resource,
  type Role,
} from "@perch/policy";
import type { Context } from "hono";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { findMembership } from "../repos/workspaces.ts";
import { clientIpOf } from "./edge.ts";
import { currentUser } from "./middleware.ts";

/** Who is acting and from where; every service call that publishes an event carries one. */
export type ActorContext = { actor: Actor; meta: EventMeta };

export function actorOf(c: Context<AppEnv>): ActorContext {
  const user = currentUser(c);
  // Forwarded headers count only from a trusted proxy (ADR-0172); see auth/edge.ts.
  const ip = clientIpOf(c);
  return {
    actor: { type: "user", id: user.id },
    meta: { requestId: c.get("requestId"), ...(ip ? { ip } : {}) },
  };
}

export type Authorized = { role: Role; ctx: AuthzContext };

function workspaceOf(resource: Resource): string {
  return resource.type === "workspace" ? resource.id : resource.workspaceId;
}

/** Throws not_found for non-members and forbidden for role/scope denials; returns the caller's role. */
export async function authorize(
  c: Context<AppEnv>,
  deps: Pick<Deps, "db">,
  action: Action,
  resource: Resource,
): Promise<Authorized> {
  const user = currentUser(c);
  const workspaceId = workspaceOf(resource);
  c.set("workspaceId", workspaceId);
  // A token bound to one workspace is a stranger everywhere else (ADR-0162): the same answer a
  // non-member gets, so a bound token cannot even tell which other workspaces its owner is in.
  const bound = c.get("authKind") === "token" ? c.get("tokenWorkspaceId") : undefined;
  if (bound && bound !== workspaceId) throw PerchError.notFound("workspace");
  const membership = await findMembership(deps.db.db, workspaceId, user.id);
  const scopes = c.get("authKind") === "token" ? (c.get("tokenScopes") ?? []) : undefined;
  const ctx: AuthzContext = {
    userId: user.id,
    role: membership?.role ?? null,
    ...(scopes ? { scopes } : {}),
  };
  const decision = decide(ctx, action, resource);
  if (!decision.allowed) {
    if (decision.reason === "not_member") throw PerchError.notFound("workspace");
    throw PerchError.forbidden(decision.message, { reason: decision.reason, action });
  }
  if (!membership) throw PerchError.notFound("workspace");
  return { role: membership.role, ctx };
}
