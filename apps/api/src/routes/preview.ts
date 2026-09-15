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
import { inspectorClient } from "@perch/inspector";
import {
  INSPECTOR_PATH,
  type PreviewTarget,
  PreviewUnreachable,
  type ProxyTarget,
  parsePreviewHost,
  parsePreviewPath,
  proxyRequest,
  SHARE_COOKIE,
  SHARE_QUERY,
  TICKET_COOKIE,
  TICKET_QUERY,
  upstreamWebSocketUrl,
  verifyPreviewTicket,
  withInspector,
} from "@perch/preview";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { WSContext } from "hono/ws";
import { authenticate } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { findMembership } from "../repos/workspaces.ts";
import {
  type TunnelSocket,
  type TunnelTarget,
  tunnelRequest,
  tunnelSocket,
} from "../services/preview-tunnel.ts";
import type { WsServer } from "../ws/server.ts";

/**
 * Whether this request is for a preview rather than for Perch. The framing and isolation headers
 * Perch sets for itself (X-Frame-Options, COOP/COEP) would keep a preview out of the Preview tab's
 * own iframe, and they are not the dev server's to inherit anyway (spec §5.6 relaxes them for
 * previews); the shell skips them here.
 */
export function isPreviewRequest(
  host: string | null | undefined,
  pathname: string,
  previewDomain: string | null | undefined,
): boolean {
  if (parsePreviewPath(pathname)) return true;
  return parsePreviewHost(host, previewDomain) !== null;
}

/** What a resolved preview request carries into the proxy. */
type Resolved = {
  workspace: Workspace;
  /** Where the dev server is, when the api can reach it; absent on the tunnel lane (task 1.19). */
  target?: ProxyTarget;
  /** The runner to tunnel through, when the api cannot reach the port itself. */
  tunnel?: TunnelTarget;
  port: number;
  path: string;
  prefix?: string;
  /**
   * Whether the inspector may be injected into this page (spec §5.6): a member looking at their own
   * workspace's preview, never a share link.
   */
  inspectable: boolean;
  /** Set when a share token or a member's ticket arrived on the query and should become a cookie. */
  keepShare?: { name: string; token: string; expiresAt: Date };
};

export function registerPreview(app: OpenAPIHono<AppEnv>, deps: Deps, wsServer?: WsServer): void {
  const resolved = new WeakMap<Request, Resolved>();

  /** HMR and anything else the dev server speaks over a socket (spec §5.6 "WS passthrough"). */
  const upgrade = wsServer?.upgradeWebSocket((c: Context<AppEnv>) => {
    const found = resolved.get(c.req.raw);
    const log = c.get("log");
    let upstream: WebSocket | null = null;
    let tunnelled: TunnelSocket | null = null;
    const backlog: (string | ArrayBuffer)[] = [];
    return {
      onOpen(_evt, ws: WSContext<unknown>) {
        if (!found) {
          ws.close(1011, "no preview target");
          return;
        }
        if (found.tunnel) {
          // A laptop's port is reached back through the socket it opened (task 1.19).
          const target = found.tunnel;
          tunnelSocket(target, c.req.raw, found.path)
            .then(async (socket) => {
              tunnelled = socket;
              await socket.ready;
              socket.onMessage((frame) => {
                if (ws.readyState === 1) ws.send(frame as string);
              });
              socket.onClose((code, reason) => {
                if (ws.readyState === 1) ws.close(closeCode(code), reason || undefined);
              });
              for (const frame of backlog.splice(0)) socket.send(frame as string);
            })
            .catch((error: unknown) => {
              log.debug({ err: error, port: target.port }, "preview tunnel socket failed");
              if (ws.readyState === 1) ws.close(1011, "the dev server's socket failed");
            });
          return;
        }
        const direct = found.target as ProxyTarget;
        // Sec-WebSocket-Protocol matters to Vite: its HMR client asks for "vite-hmr".
        const protocols = c.req.header("sec-websocket-protocol");
        const url = upstreamWebSocketUrl(direct, found.path);
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
          log.debug({ port: direct.port }, "preview socket failed");
          if (ws.readyState === 1) ws.close(1011, "the dev server's socket failed");
        });
      },
      onMessage(evt) {
        const frame = evt.data as string | ArrayBuffer;
        if (found?.tunnel) {
          if (tunnelled) tunnelled.send(frame as string);
          else backlog.push(frame);
          return;
        }
        if (!upstream || upstream.readyState === WebSocket.CONNECTING) {
          backlog.push(frame);
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
      },
      onClose() {
        upstream?.close();
        tunnelled?.close();
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
    const out: Resolved =
      reach.kind === "direct"
        ? {
            workspace,
            target: { host: reach.host, port: reach.port },
            port: reach.port,
            path: target.path,
            inspectable: admission.member === true,
          }
        : {
            workspace,
            tunnel: {
              link: reach.link,
              port: reach.port,
              workspaceId: workspace.id,
              userId: admission.userId ?? "",
            },
            port: reach.port,
            path: target.path,
            inspectable: admission.member === true,
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
    // The inspector's own script, on the preview's origin so nothing about it is cross-origin. It
    // is served from here rather than from the dev server, which has never heard of it.
    if (found.path.split("?")[0] === INSPECTOR_PATH) {
      if (!found.inspectable) throw PerchError.forbidden("a shared preview carries no inspector");
      const nonce = new URL(c.req.url).searchParams.get("nonce") ?? "";
      return new Response(inspectorClient(nonce, new URL(deps.env.publicUrl).origin), {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      if (!upgrade) throw PerchError.conflict("this instance cannot proxy preview sockets");
      resolved.set(c.req.raw, found);
      return upgrade(c, next) as Promise<Response | undefined>;
    }
    try {
      const proxied = found.tunnel
        ? await tunnelRequest(found.tunnel, c.req.raw, found.path)
        : await proxyRequest({
            target: found.target as ProxyTarget,
            path: found.path,
            request: c.req.raw,
            ...(found.prefix ? { prefix: found.prefix } : {}),
          });
      // §5.6: injected only for an authenticated preview-pane request, and never into a share.
      const answer = found.inspectable
        ? await withInspector(proxied, {
            nonce: crypto.randomUUID(),
            scriptUrl: `${found.prefix ?? ""}${INSPECTOR_PATH}`,
          })
        : proxied;
      // The share token arrived on the URL; from here on it is a cookie, so the dev server's own
      // links work without it trailing through every address bar. The response is the proxy's own,
      // so the cookie is set on it rather than on the context.
      if (found.keepShare) {
        answer.headers.append(
          "set-cookie",
          previewCookie(
            found.keepShare.name,
            found.keepShare.token,
            found.keepShare.expiresAt,
            c.req.url,
          ),
        );
      }
      return answer;
    } catch (error) {
      if (error instanceof PreviewUnreachable) {
        throw PerchError.conflict(`nothing is listening on port ${found.port} yet`, {
          port: found.port,
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

/** Who got in, and what to remember them by: the user the request then acts as (§7.6). */
type Admission = {
  ok: boolean;
  /** Who the request runs as on the runner; absent only when nobody got in. */
  userId?: string;
  /** True for a member of the workspace; false for the holder of a share link (spec §5.6). */
  member?: boolean;
  keepShare?: { name: string; token: string; expiresAt: Date };
};

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
): Promise<Admission> {
  const user = c.get("user");
  if (user) {
    const membership = await findMembership(deps.db.db, workspace.id, user.id);
    if (membership) return { ok: true, userId: user.id, member: true };
  }
  const url = new URL(c.req.url);

  // A member's ticket (ADR-0084): in wildcard mode the preview has an origin of its own — which is
  // the point — and Perch's session cookie does not reach it, so the tab that opened the preview
  // brought a short-lived ticket of its own.
  const ticketed = url.searchParams.get(TICKET_QUERY) ?? "";
  const ticket = ticketed || getCookie(c, TICKET_COOKIE) || "";
  if (ticket) {
    const claims = await verifyPreviewTicket(deps.env.sessionSecret, ticket);
    if (claims && claims.ws === workspace.id && claims.port === port) {
      const membership = await findMembership(deps.db.db, workspace.id, claims.user);
      if (membership) {
        return ticketed
          ? {
              ok: true,
              userId: claims.user,
              member: true,
              keepShare: { name: TICKET_COOKIE, token: ticket, expiresAt: new Date(claims.exp) },
            }
          : { ok: true, userId: claims.user, member: true };
      }
    }
  }

  const fromQuery = url.searchParams.get(SHARE_QUERY) ?? "";
  const token = fromQuery || getCookie(c, SHARE_COOKIE) || "";
  const share = await deps.previews.shareFor(token, { workspaceId: workspace.id, port });
  if (!share) return { ok: false };
  // A shared preview acts for whoever shared it: that is whose runner it is.
  return fromQuery
    ? {
        ok: true,
        userId: share.createdBy,
        keepShare: { name: SHARE_COOKIE, token, expiresAt: share.expiresAt },
      }
    : { ok: true, userId: share.createdBy };
}

/**
 * A preview cookie — a share's or a member's ticket — scoped to the origin it was opened on.
 *
 * The Preview tab frames the preview, so over HTTPS the cookie must survive a third-party context:
 * `SameSite=None; Secure`. Plain HTTP cannot have that (a browser drops `None` without `Secure`),
 * so it gets `Lax`, which is enough when the preview domain sits under the same registrable domain
 * as Perch — the layout §8's Caddyfile assumes, and the one the docs recommend.
 */
function previewCookie(name: string, token: string, expiresAt: Date, requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === "https:";
  return [
    `${name}=${token}`,
    "Path=/",
    "HttpOnly",
    secure ? "SameSite=None" : "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** 1005 and 1006 are "no code was given" and may not be sent back on the wire. */
function closeCode(code: number): number {
  return code === 1005 || code === 1006 || code < 1000 ? 1000 : code;
}
