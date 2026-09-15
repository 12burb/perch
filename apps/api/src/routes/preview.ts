/**
 * The preview proxy (spec §5.6, §7.1 `GET /p/{ws}/{port}/*`; task 1.18).
 *
 * Two doors to the same room. **Path mode** is `/p/{ws}/{port}/…` on Perch's own origin and works
 * with no DNS at all. **Wildcard mode** is `<port>--<workspace>.<PERCH_PREVIEW_DOMAIN>`, matched on
 * the Host header before anything else is routed, which gives the dev server an origin of its own —
 * its cookies, its storage, its service worker.
 *
 * Getting in takes either a Perch session that belongs to the workspace or a share token for that
 * exact port (§5.6: expiring, revocable, and never with the inspector). Everything else is passed
 * through as-is, HMR's WebSocket included, because a dev server is not ours to reinterpret.
 *
 * Outside the OpenAPI document on purpose: the contract here is the dev server's, not Perch's.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Workspace } from "@perch/db";
import {
  type PreviewTarget,
  PreviewUnreachable,
  type ProxyTarget,
  parsePreviewHost,
  parsePreviewPath,
  proxyRequest,
  SHARE_COOKIE,
  SHARE_QUERY,
  upstreamWebSocketUrl,
} from "@perch/preview";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { WSContext } from "hono/ws";
import { authenticate } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { findMembership } from "../repos/workspaces.ts";
import type { WsServer } from "../ws/server.ts";

/** What a resolved preview request carries into the proxy. */
type Resolved = {
  workspace: Workspace;
  target: ProxyTarget;
  path: string;
  prefix?: string;
  /** Set when a share token arrived on the query string and should become a cookie. */
  keepShare?: { token: string; expiresAt: Date };
};

export function registerPreview(app: OpenAPIHono<AppEnv>, deps: Deps, wsServer?: WsServer): void {
  const resolved = new WeakMap<Request, Resolved>();

  /** HMR and anything else the dev server speaks over a socket (spec §5.6 "WS passthrough"). */
  const upgrade = wsServer?.upgradeWebSocket((c: Context<AppEnv>) => {
    const found = resolved.get(c.req.raw);
    const log = c.get("log");
    let upstream: WebSocket | null = null;
    const backlog: (string | ArrayBuffer)[] = [];
    return {
      onOpen(_evt, ws: WSContext<unknown>) {
        if (!found) {
          ws.close(1011, "no preview target");
          return;
        }
        // Sec-WebSocket-Protocol matters to Vite: its HMR client asks for "vite-hmr".
        const protocols = c.req.header("sec-websocket-protocol");
        const url = upstreamWebSocketUrl(found.target, found.path);
        const socket = protocols
          ? new WebSocket(
              url,
              protocols.split(",").map((p) => p.trim()),
            )
          : new WebSocket(url);
        socket.binaryType = "arraybuffer";
        upstream = socket;
        socket.addEventListener("open", () => {
          for (const frame of backlog.splice(0)) socket.send(frame);
        });
        socket.addEventListener("message", (event: MessageEvent) => {
          if (ws.readyState !== 1) return;
          ws.send(event.data as string | ArrayBuffer);
        });
        socket.addEventListener("close", (event: CloseEvent) => {
          if (ws.readyState === 1) ws.close(closeCode(event.code), event.reason || undefined);
        });
        socket.addEventListener("error", () => {
          log.debug({ port: found.target.port }, "preview socket failed");
          if (ws.readyState === 1) ws.close(1011, "the dev server's socket failed");
        });
      },
      onMessage(evt) {
        const frame = evt.data as string | ArrayBuffer;
        if (!upstream || upstream.readyState === WebSocket.CONNECTING) {
          backlog.push(frame);
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
      },
      onClose() {
        upstream?.close();
      },
    };
  });

  /**
   * Resolves the workspace, checks the caller, and finds the port. Shared by both doors, because
   * the only difference between them is how the URL spells the workspace and the port.
   */
  async function resolve(c: Context<AppEnv>, target: PreviewTarget): Promise<Resolved> {
    const workspace = await deps.previews.workspaceOf(target.workspace);
    if (!workspace) throw PerchError.notFound("preview");
    const admission = await admitted(c, deps, workspace, target.port);
    if (!admission.ok) {
      throw PerchError.forbidden("this preview is not yours to open", { port: target.port });
    }
    const reach = deps.previews.reach(workspace.id, target.port);
    const out: Resolved = {
      workspace,
      target: { host: reach.host, port: reach.port },
      path: target.path,
    };
    if (target.mode === "path") out.prefix = `/p/${target.workspace}/${target.port}`;
    if (admission.keepShare) out.keepShare = admission.keepShare;
    return out;
  }

  /** One preview request: a socket upgrade, or a proxied round trip. */
  async function handle(
    c: Context<AppEnv>,
    next: () => Promise<void>,
    target: PreviewTarget,
  ): Promise<Response | undefined> {
    const found = await resolve(c, target);
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      if (!upgrade) throw PerchError.conflict("this instance cannot proxy preview sockets");
      resolved.set(c.req.raw, found);
      return upgrade(c, next) as Promise<Response | undefined>;
    }
    try {
      const answer = await proxyRequest({
        target: found.target,
        path: found.path,
        request: c.req.raw,
        ...(found.prefix ? { prefix: found.prefix } : {}),
      });
      // The share token arrived on the URL; from here on it is a cookie, so the dev server's own
      // links work without it trailing through every address bar. The response is the proxy's own,
      // so the cookie is set on it rather than on the context.
      if (found.keepShare) {
        answer.headers.append(
          "set-cookie",
          shareCookie(found.keepShare.token, found.keepShare.expiresAt, c.req.url),
        );
      }
      return answer;
    } catch (error) {
      if (error instanceof PreviewUnreachable) {
        throw PerchError.conflict(`nothing is listening on port ${found.target.port} yet`, {
          port: found.target.port,
        });
      }
      throw error;
    }
  }

  // Wildcard mode is decided on the Host header, so it has to run before any path routing: a
  // preview hostname's "/" is the dev server's "/", not Perch's.
  const byHost: MiddlewareHandler<AppEnv> = async (c, next) => {
    const target = parsePreviewHost(
      c.req.header("host"),
      deps.env.previewDomain,
      new URL(c.req.url).pathname,
      new URL(c.req.url).search,
    );
    if (!target) return next();
    await authenticate(deps)(c, async () => {});
    return handle(c, next, target);
  };

  const byPath: MiddlewareHandler<AppEnv> = async (c, next) => {
    const url = new URL(c.req.url);
    const target = parsePreviewPath(url.pathname, url.search);
    if (!target) throw PerchError.notFound("preview");
    return handle(c, next, target);
  };

  if (deps.env.previewDomain) app.use("*", byHost);
  app.use("/p/*", authenticate(deps));
  app.all("/p/:ws/:port", byPath);
  app.all("/p/:ws/:port/*", byPath);
}

/**
 * Whether this caller may open this port: a member of the workspace, or the holder of a live share
 * for that port. A share arrives on the query string once and becomes a cookie, so the dev server's
 * own links keep working without the token trailing through every URL.
 */
async function admitted(
  c: Context<AppEnv>,
  deps: Deps,
  workspace: Workspace,
  port: number,
): Promise<{ ok: boolean; keepShare?: { token: string; expiresAt: Date } }> {
  const user = c.get("user");
  if (user) {
    const membership = await findMembership(deps.db.db, workspace.id, user.id);
    if (membership) return { ok: true };
  }
  const url = new URL(c.req.url);
  const fromQuery = url.searchParams.get(SHARE_QUERY) ?? "";
  const token = fromQuery || getCookie(c, SHARE_COOKIE) || "";
  const share = await deps.previews.shareFor(token, { workspaceId: workspace.id, port });
  if (!share) return { ok: false };
  return fromQuery ? { ok: true, keepShare: { token, expiresAt: share.expiresAt } } : { ok: true };
}

/** The share cookie, scoped to whatever origin the link was opened on. */
function shareCookie(token: string, expiresAt: Date, requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === "https:";
  return [
    `${SHARE_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** 1005 and 1006 are "no code was given" and may not be sent back on the wire. */
function closeCode(code: number): number {
  return code === 1005 || code === 1006 || code < 1000 ? 1000 : code;
}
