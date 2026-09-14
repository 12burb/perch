/**
 * @perch/policy — authorize() (spec §9.1: "authorize(ctx, action, resource) from packages/policy in
 * every handler"). Pure: no database, no HTTP. The caller resolves the membership role and token scopes;
 * this module answers allow/deny with a reason. The policy.yaml evaluator (spec §5.7) joins in task 2.11.
 */

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

/** Token scopes that gate api-token callers (spec §6 api_tokens.scopes). Sessions carry no scopes. */
export type Scope = "read" | "write" | "admin" | (string & {});

export const ACTIONS = [
  "workspace.read",
  "workspace.update",
  "workspace.delete",
  "members.read",
  "members.invite",
  "members.update_role",
  "members.remove",
  "audit.read",
  "runners.read",
  "runners.connect",
  "runners.remove",
] as const;
export type Action = (typeof ACTIONS)[number];

export type Resource =
  | { type: "workspace"; id: string }
  /** A membership being changed: who it belongs to, their current role, and the role being set. */
  | { type: "member"; workspaceId: string; userId: string; role: Role; newRole?: Role };

export type AuthzContext = {
  userId: string;
  /** The caller's role in the resource's workspace, or null when not a member. */
  role: Role | null;
  /** Set when the caller authenticated with an api token; undefined for sessions. */
  scopes?: readonly string[];
};

export type Decision =
  | { allowed: true }
  | {
      allowed: false;
      /** `not_member` hides the workspace's existence; the others are a 403. */
      reason: "not_member" | "role" | "scope" | "last_owner" | "self";
      message: string;
    };

/** The role matrix: which roles may perform each action. */
export const ROLE_MATRIX: Record<Action, readonly Role[]> = {
  "workspace.read": ["owner", "admin", "member"],
  "workspace.update": ["owner", "admin"],
  "workspace.delete": ["owner"],
  "members.read": ["owner", "admin", "member"],
  "members.invite": ["owner", "admin"],
  "members.update_role": ["owner", "admin"],
  "members.remove": ["owner", "admin", "member"],
  "audit.read": ["owner", "admin"],
  "runners.read": ["owner", "admin", "member"],
  // Any member may connect a machine of their own; it serves only them (spec §3.2).
  "runners.connect": ["owner", "admin", "member"],
  // Removing someone else's runner; owners of a runner remove their own through the same route.
  "runners.remove": ["owner", "admin"],
};

/** The token scope each action needs: read → `read`; writes → `write`; administration → `admin`. */
export const SCOPE_FOR_ACTION: Record<Action, "read" | "write" | "admin"> = {
  "workspace.read": "read",
  "workspace.update": "admin",
  "workspace.delete": "admin",
  "members.read": "read",
  "members.invite": "admin",
  "members.update_role": "admin",
  "members.remove": "admin",
  "audit.read": "admin",
  "runners.read": "read",
  "runners.connect": "write",
  "runners.remove": "admin",
};

const SCOPE_IMPLIES: Record<"read" | "write" | "admin", readonly string[]> = {
  read: ["read", "write", "admin"],
  write: ["write", "admin"],
  admin: ["admin"],
};

export function scopeAllows(
  scopes: readonly string[],
  needed: "read" | "write" | "admin",
): boolean {
  return SCOPE_IMPLIES[needed].some((s) => scopes.includes(s));
}

function deny(reason: Exclude<Decision, { allowed: true }>["reason"], message: string): Decision {
  return { allowed: false, reason, message };
}

/**
 * Decides whether `ctx` may perform `action` on `resource`.
 * Order: membership → token scope → role → per-resource rules (owner changes, last owner, self).
 */
export function authorize(ctx: AuthzContext, action: Action, resource: Resource): Decision {
  if (ctx.role === null) return deny("not_member", "not a member of this workspace");
  if (ctx.scopes && !scopeAllows(ctx.scopes, SCOPE_FOR_ACTION[action])) {
    return deny("scope", `this token lacks the ${SCOPE_FOR_ACTION[action]} scope`);
  }

  if (resource.type === "member") {
    const self = resource.userId === ctx.userId;
    if (action === "members.remove" && ctx.role === "member" && !self) {
      return deny("role", "members can only remove themselves");
    }
    if (action === "members.update_role" && self) {
      return deny("self", "you cannot change your own role");
    }
    if (!ROLE_MATRIX[action].includes(ctx.role)) return deny("role", `requires ${who(action)}`);
    // Only an owner touches owners: removing one, demoting one, or promoting someone to owner.
    const touchesOwner = resource.role === "owner" || resource.newRole === "owner";
    if (touchesOwner && ctx.role !== "owner" && !(self && action === "members.remove")) {
      return deny("role", "only an owner can change owners");
    }
    return { allowed: true };
  }

  if (!ROLE_MATRIX[action].includes(ctx.role)) return deny("role", `requires ${who(action)}`);
  return { allowed: true };
}

function who(action: Action): string {
  const roles = ROLE_MATRIX[action];
  return roles.length === 1 ? `the ${roles[0]} role` : `one of ${roles.join(", ")}`;
}

export function can(ctx: AuthzContext, action: Action, resource: Resource): boolean {
  return authorize(ctx, action, resource).allowed;
}

export const packageName = "@perch/policy";
