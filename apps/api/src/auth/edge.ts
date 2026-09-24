/**
 * The request edge (ADR-0172): the checks every request meets before a route decides anything.
 *
 * - **Host.** A request whose Host is not one of this instance's names is refused, so a page that
 *   re-points its own DNS name at a Perch on a laptop or a private network (DNS rebinding) cannot
 *   drive it — the unauthenticated setup wizard included.
 * - **Origin.** A state-changing request, or a WebSocket upgrade, that a session cookie
 *   authenticates must come from Perch's own pages. Previews are recommended to sit on the same
 *   site as Perch, and a same-site page's requests carry the Lax session cookie; the Origin (or
 *   Sec-Fetch-Site) header is what tells them apart.
 * - **Client address.** X-Forwarded-For is believed only from a configured proxy, walked from the
 *   right past the proxies to the first address none of them is; any other peer is its own socket
 *   address. The audit log and better-auth's per-address limits both use that one answer.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import type { AppEnv } from "../context.ts";
import type { Env } from "../env.ts";
import { PerchError } from "../errors.ts";

type EdgeEnv = Pick<Env, "publicUrl" | "mode" | "previewDomain" | "allowedHosts" | "runner">;

// ---------------------------------------------------------------------------------------------
// Origin

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Origins Perch's own pages load from: the public URL's, and in laptop mode the Vite dev server's. */
export function trustedOrigins(env: Pick<Env, "publicUrl" | "mode">): readonly string[] {
  const own = new URL(env.publicUrl).origin;
  return env.mode === "laptop" ? [own, "http://localhost:5173", "http://127.0.0.1:5173"] : [own];
}

type RequestView = { header(name: string): string | undefined; url: string };

/**
 * Whether a request comes from Perch's own pages. Browsers send Origin on every state-changing
 * request and every WebSocket handshake; when it is present it must be a trusted origin or the
 * origin the request was addressed to. Without it, Sec-Fetch-Site (sent by current browsers) must
 * not say another site or origin. A request with neither did not come from a browser page.
 */
export function fromOwnOrigin(req: RequestView, env: Pick<Env, "publicUrl" | "mode">): boolean {
  const origin = req.header("origin");
  if (origin !== undefined) {
    if (trustedOrigins(env).includes(origin)) return true;
    return origin !== "null" && origin === new URL(req.url).origin;
  }
  const site = req.header("sec-fetch-site");
  return site === undefined || site === "same-origin" || site === "none";
}

function refuseCrossOrigin(): PerchError {
  return PerchError.forbidden("this request did not come from Perch's own pages", {
    reason: "cross_origin",
  });
}

/**
 * Refuses a cookie-authenticated POST, PUT, PATCH or DELETE from another origin. Bearer callers
 * are not affected: a browser cannot attach an Authorization header across origins without a
 * CORS approval Perch never gives, and a bearer request never reads the cookie.
 */
export function crossOriginWrites(env: Pick<Env, "publicUrl" | "mode">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (
      c.get("authKind") === "session" &&
      UNSAFE_METHODS.has(c.req.method) &&
      !fromOwnOrigin(c.req, env)
    ) {
      throw refuseCrossOrigin();
    }
    await next();
  };
}

/** Refuses a cookie-authenticated WebSocket upgrade from another origin (/api/ws, terminals). */
export function crossOriginUpgrade(
  env: Pick<Env, "publicUrl" | "mode">,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get("authKind") === "session" && !fromOwnOrigin(c.req, env)) throw refuseCrossOrigin();
    await next();
  };
}

// ---------------------------------------------------------------------------------------------
// Host

/** The host name of a Host header value or a bare name: lowercase, no port, brackets or final dot. */
function hostnameOf(host: string): string {
  const trimmed = host.trim().toLowerCase();
  const name = trimmed.startsWith("[")
    ? trimmed.slice(1, trimmed.indexOf("]") > 0 ? trimmed.indexOf("]") : undefined)
    : trimmed.replace(/:\d+$/, "");
  return name.replace(/\.$/, "");
}

/**
 * Whether this instance answers to a Host. An IP literal and a loopback name are never a rebound
 * name — a rebinding page is served under a DNS name of the attacker's — so they are always
 * answered; every other name must be the public URL's, the runner URL's, the preview domain (or a
 * name under it), or one PERCH_ALLOWED_HOSTS lists.
 */
export function hostAllowed(host: string, env: EdgeEnv): boolean {
  const name = hostnameOf(host);
  if (name === "") return false;
  if (isIP(name) !== 0) return true;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === hostnameOf(new URL(env.publicUrl).host)) return true;
  if (env.runner.apiUrl && name === hostnameOf(new URL(env.runner.apiUrl).host)) return true;
  const preview = env.previewDomain ? hostnameOf(env.previewDomain) : "";
  if (preview && (name === preview || name.endsWith(`.${preview}`))) return true;
  return env.allowedHosts.some((allowed) => hostnameOf(allowed) === name);
}

/**
 * The runner lane (spec §7.6): a runner container dials the api by its service name (`api:3000`
 * in the compose file) with a connect token, the credential a rebinding page never holds.
 */
function isRunnerLane(path: string): boolean {
  return path === "/api/runner" || path.startsWith("/api/runner/stream/");
}

/** Refuses a request addressed to a name this instance does not answer to (DNS rebinding). */
export function hostGuard(env: EdgeEnv): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const host = c.req.header("host");
    // No Host header means no browser sent it; everything a browser sends carries one.
    if (host !== undefined && !isRunnerLane(c.req.path) && !hostAllowed(host, env)) {
      throw PerchError.forbidden("this instance does not answer to that host name", {
        reason: "host_not_allowed",
      });
    }
    await next();
  };
}

// ---------------------------------------------------------------------------------------------
// Client address

const RESOLVE_EVERY_MS = 30_000;

/** Which peers are proxies whose X-Forwarded-For is believed: loopback, plus PERCH_TRUSTED_PROXIES. */
export class ProxyTrust {
  readonly #literal = new BlockList();
  readonly #names: string[] = [];
  #resolved = new BlockList();
  #resolvedAt = 0;
  #resolving: Promise<void> | null = null;

  constructor(entries: readonly string[]) {
    this.#literal.addSubnet("127.0.0.0", 8, "ipv4");
    this.#literal.addAddress("::1", "ipv6");
    for (const entry of entries) {
      const [address = "", prefix] = entry.split("/");
      const family = isIP(address);
      if (family === 0) {
        this.#names.push(entry.toLowerCase());
        continue;
      }
      const type = family === 4 ? "ipv4" : "ipv6";
      if (prefix === undefined) this.#literal.addAddress(address, type);
      else this.#literal.addSubnet(address, Number(prefix), type);
    }
  }

  /**
   * Looks the named proxies up again when the last answer is older than RESOLVE_EVERY_MS. The
   * first lookup is waited for; later ones run behind the request, which uses the last answer.
   */
  async refresh(now = Date.now()): Promise<void> {
    if (this.#names.length === 0 || now - this.#resolvedAt < RESOLVE_EVERY_MS) return;
    const first = this.#resolvedAt === 0;
    this.#resolving ??= (async () => {
      const next = new BlockList();
      for (const name of this.#names) {
        const found = await lookup(name, { all: true }).catch(() => []);
        for (const one of found) next.addAddress(one.address, one.family === 6 ? "ipv6" : "ipv4");
      }
      this.#resolved = next;
      this.#resolvedAt = Date.now();
    })().finally(() => {
      this.#resolving = null;
    });
    if (first) await this.#resolving;
  }

  trusts(address: string): boolean {
    const family = isIP(address);
    if (family === 0) return false;
    const type = family === 4 ? "ipv4" : "ipv6";
    return this.#literal.check(address, type) || this.#resolved.check(address, type);
  }
}

/** `::ffff:192.0.2.1` is 192.0.2.1: one address, one spelling in the audit log. */
function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped?.[1] ?? address;
}

function peerOf(c: Context<AppEnv>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // In-process requests (tests, app.request) have no socket.
    return undefined;
  }
}

/**
 * The client's address. The socket peer, unless the peer is a trusted proxy: then the right-most
 * X-Forwarded-For entry that is not itself a trusted proxy (the left-most entries are whatever the
 * client chose to send), or X-Real-IP when there is no X-Forwarded-For.
 */
export function resolveClientAddress(
  peer: string | undefined,
  headers: { forwardedFor: string | undefined; realIp: string | undefined },
  trust: ProxyTrust,
): string | undefined {
  if (peer === undefined || peer === "") return undefined;
  const socket = normalizeAddress(peer);
  if (!trust.trusts(socket)) return socket;
  const hops = (headers.forwardedFor ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  if (hops.length === 0) {
    const real = headers.realIp?.trim();
    return real && isIP(real) !== 0 ? normalizeAddress(real) : socket;
  }
  let last = socket;
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = normalizeAddress(hops[i] ?? "");
    if (isIP(hop) === 0) return last;
    if (!trust.trusts(hop)) return hop;
    last = hop;
  }
  return last;
}

const clientAddresses = new WeakMap<Request, string | undefined>();

/** Resolves the client address once per request, for the audit log and for better-auth. */
export function clientAddress(trust: ProxyTrust): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await trust.refresh();
    clientAddresses.set(
      c.req.raw,
      resolveClientAddress(
        peerOf(c),
        { forwardedFor: c.req.header("x-forwarded-for"), realIp: c.req.header("x-real-ip") },
        trust,
      ),
    );
    await next();
  };
}

/** The address clientAddress() resolved; without it, the socket peer and never a header. */
export function clientIpOf(c: Context<AppEnv>): string | undefined {
  if (clientAddresses.has(c.req.raw)) return clientAddresses.get(c.req.raw);
  const peer = peerOf(c);
  return peer ? normalizeAddress(peer) : undefined;
}

/**
 * The request better-auth sees: X-Forwarded-For replaced by the one address resolved here, so its
 * per-address limits key on the real client and not on a header any caller can write.
 */
export function withResolvedClient(c: Context<AppEnv>): Request {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-real-ip");
  const ip = clientIpOf(c);
  if (ip) headers.set("x-forwarded-for", ip);
  else headers.delete("x-forwarded-for");
  return new Request(c.req.raw, { headers });
}
