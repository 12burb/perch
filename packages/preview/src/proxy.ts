/**
 * The preview proxy (spec §5.6; task 1.18): Perch in front of a dev server running on a runner.
 *
 * It is deliberately thin. A dev server is a moving target — HMR over WebSockets, chunked
 * responses, `Vary` on everything, absolute redirects to its own origin — so the safest proxy is
 * one that changes as little as it can get away with: strip the hop-by-hop headers HTTP/1.1 says
 * are not ours to forward, rewrite redirects that point back at the dev server's own origin, and
 * pass the body through as a stream.
 */

/** Headers that belong to one hop and must not be forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Headers Perch's own auth rides on, which a dev server has no business seeing. */
const PERCH_ONLY = new Set(["cookie", "authorization"]);

export type ProxyTarget = {
  /** Where the dev server actually listens, as the api can reach it. */
  host: string;
  port: number;
};

export type ProxyOptions = {
  target: ProxyTarget;
  /** The path (with query) to ask the dev server for. */
  path: string;
  request: Request;
  /**
   * In path mode the browser's origin is Perch's and the path is prefixed, so a redirect to "/foo"
   * has to come back as "/p/<ws>/<port>/foo". Absent in wildcard mode, where the origin is the
   * preview's own and nothing needs rewriting.
   */
  prefix?: string;
  /** Milliseconds before giving up on the dev server (default 30s: a cold Vite start is slow). */
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export class PreviewUnreachable extends Error {
  constructor(
    readonly target: ProxyTarget,
    override readonly cause: unknown,
  ) {
    super(`nothing is listening on port ${target.port}`);
    this.name = "PreviewUnreachable";
  }
}

/** The request as the dev server should see it. */
export function upstreamRequest(options: ProxyOptions): Request {
  const url = `http://${options.target.host}:${options.target.port}${options.path}`;
  const headers = new Headers();
  for (const [name, value] of options.request.headers) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || PERCH_ONLY.has(key)) continue;
    // The dev server is not on Perch's host and should not think it is: Vite's allowedHosts and
    // every framework's absolute-URL helper read this.
    if (key === "host") continue;
    headers.append(name, value);
  }
  headers.set("host", `${options.target.host}:${options.target.port}`);
  // Say what we are, so a dev server that cares can build correct absolute URLs.
  const forwarded = options.request.headers.get("x-forwarded-for");
  if (forwarded) headers.set("x-forwarded-for", forwarded);
  headers.set("x-forwarded-proto", new URL(options.request.url).protocol.replace(":", ""));
  headers.set("x-forwarded-host", new URL(options.request.url).host);
  const body =
    options.request.method === "GET" || options.request.method === "HEAD"
      ? undefined
      : options.request.body;
  return new Request(url, {
    method: options.request.method,
    headers,
    ...(body ? { body, duplex: "half" } : {}),
    redirect: "manual",
  } as RequestInit & { duplex?: "half" });
}

/** The dev server's answer as the browser should see it. */
export function downstreamResponse(
  upstream: Response,
  options: { prefix?: string; target: ProxyTarget },
): Response {
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers.append(name, value);
  }
  // A dev server redirecting to its own origin means "somewhere else on me", which in path mode is
  // somewhere else under the prefix.
  const location = upstream.headers.get("location");
  if (location) {
    const rewritten = rewriteLocation(location, options);
    if (rewritten !== null) headers.set("location", rewritten);
  }
  // Nothing here is Perch's to cache, and a stale preview is a confusing preview.
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** A Location that points at the dev server, moved onto the URL the browser is actually using. */
export function rewriteLocation(
  location: string,
  options: { prefix?: string; target: ProxyTarget },
): string | null {
  const prefix = options.prefix;
  if (!prefix) return null;
  const origin = `http://${options.target.host}:${options.target.port}`;
  if (location.startsWith(origin)) {
    const rest = location.slice(origin.length) || "/";
    return `${prefix}${rest.startsWith("/") ? rest : `/${rest}`}`;
  }
  // A root-relative redirect is relative to the dev server's root, not Perch's.
  if (location.startsWith("/") && !location.startsWith("//")) return `${prefix}${location}`;
  return null;
}

/** One proxied request, start to finish. */
export async function proxyRequest(options: ProxyOptions): Promise<Response> {
  const call = options.fetch ?? fetch;
  const request = upstreamRequest(options);
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  let upstream: Response;
  try {
    upstream = await call(request, { signal, redirect: "manual" });
  } catch (error) {
    throw new PreviewUnreachable(options.target, error);
  }
  const rest: { prefix?: string; target: ProxyTarget } = { target: options.target };
  if (options.prefix) rest.prefix = options.prefix;
  return downstreamResponse(upstream, rest);
}

/** The dev server's WebSocket URL for a path: what HMR connects to (spec §5.6 "WS passthrough"). */
export function upstreamWebSocketUrl(target: ProxyTarget, path: string): string {
  return `ws://${target.host}:${target.port}${path.startsWith("/") ? path : `/${path}`}`;
}
