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
  "projects.read",
  "projects.create",
  "projects.update",
  "projects.delete",
  "deploy_key.read",
  "deploy_key.rotate",
  "sessions.read",
  "sessions.create",
  "sessions.update",
  "brains.read",
  "brains.write",
  "brains.admin",
  "connections.read",
  "connections.write",
  "connections.admin",
  "previews.read",
  "previews.share",
  "channels.read",
  "channels.create",
  "channels.update",
  "channels.archive",
  "messages.read",
  "messages.write",
  "messages.moderate",
  "files.read",
  "files.write",
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
  // Projects (task 1.4): every member works in them; deleting one and rotating the deploy key are
  // administrative (the key is added to repositories outside Perch).
  "projects.read": ["owner", "admin", "member"],
  "projects.create": ["owner", "admin", "member"],
  "projects.update": ["owner", "admin", "member"],
  "projects.delete": ["owner", "admin"],
  "deploy_key.read": ["owner", "admin", "member"],
  "deploy_key.rotate": ["owner", "admin"],
  // Sessions (task 1.8): every member opens and drives agent sessions in the workspace's projects.
  "sessions.read": ["owner", "admin", "member"],
  "sessions.create": ["owner", "admin", "member"],
  "sessions.update": ["owner", "admin", "member"],
  // Brains (task 1.15): everyone sees which brains exist and may add their own key; the workspace's
  // shared credentials and its model profiles belong to the admins.
  "brains.read": ["owner", "admin", "member"],
  "brains.write": ["owner", "admin", "member"],
  "brains.admin": ["owner", "admin"],
  // Connections (task 1.16): everyone sees the ones they may use and may connect their own
  // account; a connection the whole workspace runs on, and its grants, belong to the admins.
  "connections.read": ["owner", "admin", "member"],
  "connections.write": ["owner", "admin", "member"],
  "connections.admin": ["owner", "admin"],
  // Anyone who can open a project can watch it run; sharing it outside is the same weight as
  // changing the project, because a share link leaves the workspace.
  "previews.read": ["owner", "admin", "member"],
  "previews.share": ["owner", "admin", "member"],
  // Chat (task 2.1): a workspace is a place to talk, so every member starts channels, joins the
  // public ones, and sets a topic. Archiving takes a channel away from everybody who is in it, so
  // it stays with the people who answer for the workspace (ADR-0090).
  "channels.read": ["owner", "admin", "member"],
  "channels.create": ["owner", "admin", "member"],
  "channels.update": ["owner", "admin", "member"],
  "channels.archive": ["owner", "admin"],
  // Messages (task 2.2): everybody reads and writes in the channels they are in; editing and
  // deleting your own is part of writing. Taking down somebody else's is moderation.
  "messages.read": ["owner", "admin", "member"],
  "messages.write": ["owner", "admin", "member"],
  "messages.moderate": ["owner", "admin"],
  // Files (task 2.3): an upload is something said in the workspace, so it follows messages. A
  // guest reads what they are shown and uploads nothing.
  "files.read": ["owner", "admin", "member"],
  "files.write": ["owner", "admin", "member"],
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
  "projects.read": "read",
  "projects.create": "write",
  "projects.update": "write",
  "projects.delete": "admin",
  "deploy_key.read": "read",
  "deploy_key.rotate": "admin",
  "sessions.read": "read",
  "sessions.create": "write",
  "sessions.update": "write",
  "brains.read": "read",
  "brains.write": "write",
  "brains.admin": "admin",
  "connections.read": "read",
  "connections.write": "write",
  "connections.admin": "admin",
  "previews.read": "read",
  "previews.share": "write",
  "channels.read": "read",
  "channels.create": "write",
  "channels.update": "write",
  "channels.archive": "write",
  "messages.read": "read",
  "messages.write": "write",
  "messages.moderate": "write",
  "files.read": "read",
  "files.write": "write",
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
