/**
 * The api-token half of authorize() for the routes that have no workspace resource to authorize
 * against (ADR-0162, ADR-0172): the caller's own profile and tokens, their workspace list, their
 * inbox, the instance-admin pages, and the preview door.
 *
 * `authorize()` applies a token's scopes and its workspace binding, but only on routes that name a
 * workspace. Everything else used to answer any token as if it were the signed-in person, so a
 * narrow token (`chat:read`, bound to one workspace) could list every workspace, mint a wider
 * token, or change instance settings. These helpers make that half explicit and shared.
 *
 * A session carries no scopes and no binding: every check here passes for it.
 */
import { scopeAllows } from "@perch/policy";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { PerchError } from "../errors.ts";

/** The token scopes a route can ask for (spec §6 `api_tokens.scopes`). */
export type TokenScope = "read" | "write" | "admin";

/** What the checks read: the auth variables authenticate() set on the context. */
export type Caller = Pick<Context<AppEnv>, "get">;

/** The workspace the calling token is bound to, if the caller is a bound token. */
export function boundWorkspace(c: Caller): string | undefined {
  return c.get("authKind") === "token" ? c.get("tokenWorkspaceId") : undefined;
}

/**
 * Whether the caller may act here.
 *
 * - `workspaceId` a string: the action is inside that workspace; a token bound elsewhere may not.
 * - `workspaceId` null: the action reaches past any one workspace (the instance, the person's
 *   whole account); a bound token may not.
 * - `workspaceId` omitted: the route narrows what it returns to the binding itself.
 */
export function tokenAllows(c: Caller, scope: TokenScope, workspaceId?: string | null): boolean {
  if (c.get("authKind") !== "token") return true;
  if (!scopeAllows(c.get("tokenScopes") ?? [], scope)) return false;
  const bound = boundWorkspace(c);
  if (bound === undefined || workspaceId === undefined) return true;
  return workspaceId === bound;
}

/**
 * Throws unless the caller may act here (see tokenAllows). A missing scope is `forbidden` with
 * reason `scope`; a bound token outside its workspace gets the `not_found` a non-member gets, so it
 * cannot tell which other workspaces exist; a bound token on an instance-wide route is `forbidden`
 * with reason `token_bound`.
 */
export function tokenGate(c: Caller, scope: TokenScope, workspaceId?: string | null): void {
  if (c.get("authKind") !== "token") return;
  if (!scopeAllows(c.get("tokenScopes") ?? [], scope)) {
    throw PerchError.forbidden(`this token lacks the ${scope} scope`, { reason: "scope", scope });
  }
  const bound = boundWorkspace(c);
  if (bound === undefined || workspaceId === undefined) return;
  if (workspaceId === null) {
    throw PerchError.forbidden("a token bound to one workspace cannot do this", {
      reason: "token_bound",
    });
  }
  if (workspaceId !== bound) throw PerchError.notFound("workspace");
}

/**
 * Only a signed-in person, never an api token (ADR-0045: tokens are made from a session). A token
 * that could mint tokens could mint one wider, unbound, or longer-lived than itself.
 */
export function requireSession(c: Caller): void {
  if (c.get("authKind") !== "session") {
    throw PerchError.forbidden("this needs a signed-in session, not an api token", {
      reason: "session_required",
    });
  }
}
