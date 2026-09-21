/**
 * Request authentication (spec §7.1): a session cookie (web) or `Authorization: Bearer <api token>`
 * (SDKs, the MCP server). Sets the current user on the context; `requireUser` guards routes.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { findUserByAuthUserId, findUserById } from "../repos/users.ts";
import { resolveApiToken } from "../services/tokens.ts";

export function authenticate(deps: Pick<Deps, "db" | "auth">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    if (header?.startsWith("Bearer ")) {
      const token = header.slice("Bearer ".length).trim();
      if (token.startsWith("pat_")) {
        const resolved = await resolveApiToken(deps.db.db, token);
        if (resolved) {
          const user = await findUserById(deps.db.db, resolved.userId);
          if (user) {
            c.set("user", user);
            c.set("userId", user.id);
            c.set("authKind", "token");
            c.set("tokenScopes", resolved.scopes);
            if (resolved.workspaceId) c.set("tokenWorkspaceId", resolved.workspaceId);
          }
        }
      }
      return next();
    }
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (session) {
      const user = await findUserByAuthUserId(deps.db.db, session.user.id);
      if (user) {
        c.set("user", user);
        c.set("userId", user.id);
        c.set("authKind", "session");
      }
    }
    return next();
  };
}

/** Routes that need a signed-in user. Unauthenticated calls get the §7.8 forbidden shape. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")) {
    throw PerchError.forbidden("authentication required", { reason: "unauthenticated" });
  }
  await next();
};

export function currentUser(c: { get: (key: "user") => AppEnv["Variables"]["user"] }) {
  const user = c.get("user");
  if (!user) throw PerchError.forbidden("authentication required", { reason: "unauthenticated" });
  return user;
}
