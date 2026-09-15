import { describe, expect, test } from "bun:test";
import { ACTIONS, type Action, authorize, can, type Role, scopeAllows } from "../src/index.ts";

const WS = "0190f2d0-0000-7000-8000-000000000001";
const ME = "0190f2d0-0000-7000-8000-0000000000aa";
const OTHER = "0190f2d0-0000-7000-8000-0000000000bb";
const workspace = { type: "workspace", id: WS } as const;

function ctx(role: Role | null, scopes?: string[]) {
  return { userId: ME, role, ...(scopes ? { scopes } : {}) };
}

describe("authorize (task 0.9)", () => {
  test("a non-member is denied every action with not_member (hides existence)", () => {
    for (const action of ACTIONS) {
      const decision = authorize(ctx(null), action, workspace);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe("not_member");
    }
  });

  test("the role matrix", () => {
    const expected: Record<Action, Record<Role, boolean>> = {
      "workspace.read": { owner: true, admin: true, member: true },
      "workspace.update": { owner: true, admin: true, member: false },
      "workspace.delete": { owner: true, admin: false, member: false },
      "members.read": { owner: true, admin: true, member: true },
      "members.invite": { owner: true, admin: true, member: false },
      "members.update_role": { owner: true, admin: true, member: false },
      "members.remove": { owner: true, admin: true, member: true },
      "audit.read": { owner: true, admin: true, member: false },
      "runners.read": { owner: true, admin: true, member: true },
      "runners.connect": { owner: true, admin: true, member: true },
      "runners.remove": { owner: true, admin: true, member: false },
      "projects.read": { owner: true, admin: true, member: true },
      "projects.create": { owner: true, admin: true, member: true },
      "projects.update": { owner: true, admin: true, member: true },
      "projects.delete": { owner: true, admin: true, member: false },
      "deploy_key.read": { owner: true, admin: true, member: true },
      "deploy_key.rotate": { owner: true, admin: true, member: false },
      "sessions.read": { owner: true, admin: true, member: true },
      "sessions.create": { owner: true, admin: true, member: true },
      "sessions.update": { owner: true, admin: true, member: true },
      "brains.read": { owner: true, admin: true, member: true },
      "brains.write": { owner: true, admin: true, member: true },
      "brains.admin": { owner: true, admin: true, member: false },
      "connections.read": { owner: true, admin: true, member: true },
      "connections.write": { owner: true, admin: true, member: true },
      "connections.admin": { owner: true, admin: true, member: false },
      "previews.read": { owner: true, admin: true, member: true },
      "previews.share": { owner: true, admin: true, member: true },
      "channels.read": { owner: true, admin: true, member: true },
      "channels.create": { owner: true, admin: true, member: true },
      "channels.update": { owner: true, admin: true, member: true },
      "channels.archive": { owner: true, admin: true, member: false },
      "messages.read": { owner: true, admin: true, member: true },
      "messages.write": { owner: true, admin: true, member: true },
      "messages.moderate": { owner: true, admin: true, member: false },
      "files.read": { owner: true, admin: true, member: true },
      "files.write": { owner: true, admin: true, member: true },
    };
    for (const action of ACTIONS) {
      for (const role of ["owner", "admin", "member"] as const) {
        const resource =
          action.startsWith("members.") && action !== "members.read"
            ? ({ type: "member", workspaceId: WS, userId: OTHER, role: "member" } as const)
            : workspace;
        const got = can(ctx(role), action, resource);
        if (action === "members.remove" && role === "member") {
          expect(got).toBe(false); // members remove only themselves
        } else {
          expect(got).toBe(expected[action][role]);
        }
      }
    }
  });

  test("owner rules: only owners touch owners; nobody changes their own role", () => {
    const owner = { type: "member", workspaceId: WS, userId: OTHER, role: "owner" } as const;
    expect(can(ctx("admin"), "members.remove", owner)).toBe(false);
    expect(can(ctx("admin"), "members.update_role", { ...owner, newRole: "member" })).toBe(false);
    expect(can(ctx("owner"), "members.update_role", { ...owner, newRole: "member" })).toBe(true);
    const promote = {
      type: "member",
      workspaceId: WS,
      userId: OTHER,
      role: "member",
      newRole: "owner",
    } as const;
    expect(can(ctx("admin"), "members.update_role", promote)).toBe(false);
    expect(can(ctx("owner"), "members.update_role", promote)).toBe(true);
    const self = {
      type: "member",
      workspaceId: WS,
      userId: ME,
      role: "owner",
      newRole: "member",
    } as const;
    const decision = authorize(ctx("owner"), "members.update_role", self);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("self");
  });

  test("anyone may leave (remove themselves), including a member", () => {
    const self = { type: "member", workspaceId: WS, userId: ME, role: "member" } as const;
    expect(can(ctx("member"), "members.remove", self)).toBe(true);
    const selfOwner = { type: "member", workspaceId: WS, userId: ME, role: "owner" } as const;
    expect(can(ctx("owner"), "members.remove", selfOwner)).toBe(true);
  });

  test("token scopes gate api-token callers; sessions carry none", () => {
    expect(scopeAllows(["read"], "read")).toBe(true);
    expect(scopeAllows(["read"], "write")).toBe(false);
    expect(scopeAllows(["write"], "read")).toBe(true);
    expect(scopeAllows(["admin"], "write")).toBe(true);
    expect(scopeAllows(["chat:read"], "read")).toBe(false);
    const readOnly = authorize(ctx("owner", ["read"]), "workspace.update", workspace);
    expect(readOnly.allowed).toBe(false);
    if (!readOnly.allowed) expect(readOnly.reason).toBe("scope");
    expect(can(ctx("owner", ["read"]), "workspace.read", workspace)).toBe(true);
    expect(can(ctx("owner", ["admin"]), "audit.read", workspace)).toBe(true);
    expect(can(ctx("owner"), "audit.read", workspace)).toBe(true);
  });
});
