/**
 * The one address-checked outbound fetch (ADR-0173). Every URL a member supplies — a connection's
 * API base or MCP server, anything MCP discovery finds from there, a brain's base URL, a web-push
 * endpoint — is fetched through this, so a member cannot use the api as a way into the api's own
 * network.
 *
 * What it does, on every hop:
 * - only `http:` and `https:` (and only `https:` where the caller asks for it);
 * - the host is resolved, and every address it resolves to must be public (./address.ts) — one
 *   private answer among public ones is enough to refuse;
 * - redirects are followed by hand, each new location checked the same way, and credentials are
 *   dropped when a redirect leaves the origin;
 * - the whole exchange has a deadline, and the answer's body is capped.
 *
 * What it does not do: pin the connection to the address it checked. The platform fetch resolves
 * the name again, so a name whose answer changes between the check and the connect (DNS rebinding)
 * can still slip through that window. The check narrows the door to that race; it does not weld it.
 *
 * URLs an operator configured — a manifest's own endpoints, PERCH_OLLAMA_URL — are not a member's
 * say-so and are not routed through here. In laptop mode, or when the operator sets
 * PERCH_OUTBOUND_ALLOW_PRIVATE, private addresses are allowed: the person using Perch is the person
 * who owns the network.
 */
import { lookup } from "node:dns/promises";
import { PerchError } from "../errors.ts";
import { deniedAddress, isIpLiteral } from "./address.ts";

/** Just enough of fetch: the global is assignable, and so is a test's stand-in. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The instance's rule for member-supplied URLs. */
export type OutboundPolicy = {
  /** Private, loopback and link-local addresses are reachable (laptop mode, or an operator's say). */
  allowPrivate: boolean;
};

/** Public addresses only: the default wherever nobody said otherwise. */
export const PUBLIC_ONLY: OutboundPolicy = { allowPrivate: false };

/** Every address a hostname resolves to. */
export type Resolver = (hostname: string) => Promise<string[]>;

export type OutboundOptions = {
  policy?: OutboundPolicy | undefined;
  /** Refuse plain `http:` (unless the policy allows private addresses, where a stand-in lives). */
  requireHttps?: boolean | undefined;
  /** The deadline for the whole exchange, redirects and body included. */
  timeoutMs?: number | undefined;
  /** The largest answer body read before the exchange is abandoned. */
  maxBytes?: number | undefined;
  maxRedirects?: number | undefined;
  /** How names are resolved (tests stand in for DNS here). */
  resolve?: Resolver | undefined;
  /** What actually makes the request, under the checks (tests stand in for a server here). */
  transport?: FetchLike | undefined;
};

export const OUTBOUND_TIMEOUT_MS = 15_000;
export const OUTBOUND_MAX_BYTES = 10 * 1024 * 1024;
export const OUTBOUND_MAX_REDIRECTS = 5;

/**
 * Why an outbound request was not made, or was abandoned. `refused` is the URL itself — a scheme,
 * or an address the policy does not allow; `unresolved` is a name with no answer right now, which
 * may be a passing DNS failure; `limit` is a redirect chain or an answer that ran too long. The
 * message names the host, never an address it resolved to.
 */
export type RefusalKind = "refused" | "unresolved" | "limit";

export class OutboundRefused extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly kind: RefusalKind = "refused",
  ) {
    super(message);
    this.name = "OutboundRefused";
  }
}

const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Checks one URL against the policy: the scheme, then every address its host resolves to. Returns
 * the parsed URL, or throws OutboundRefused.
 */
export async function checkOutbound(
  input: string | URL,
  options: OutboundOptions = {},
): Promise<URL> {
  const text = String(input);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new OutboundRefused("that is not a URL", text);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OutboundRefused(`${url.protocol} is not a web address`, text);
  }
  const policy = options.policy ?? PUBLIC_ONLY;
  if (options.requireHttps && url.protocol !== "https:" && !policy.allowPrivate) {
    throw new OutboundRefused(`${url.host} must be reached over https`, text);
  }
  if (policy.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIpLiteral(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await (options.resolve ?? systemResolver)(host);
    } catch {
      addresses = [];
    }
  }
  if (addresses.length === 0) {
    throw new OutboundRefused(`${url.hostname} could not be resolved`, text, "unresolved");
  }
  for (const address of addresses) {
    const why = deniedAddress(address);
    if (why) {
      throw new OutboundRefused(
        `${url.hostname} is ${why === "not an IP address" ? "not a public address" : why}; Perch reaches only public addresses for a URL a member supplies`,
        text,
      );
    }
  }
  return url;
}

/**
 * The same check as a validation error, for the moment a member hands Perch a URL: a 422 naming
 * the field, rather than a failure at the first call made with it.
 */
export async function requireReachable(
  url: string,
  field: string,
  options: OutboundOptions = {},
): Promise<void> {
  try {
    await checkOutbound(url, options);
  } catch (error) {
    if (error instanceof OutboundRefused) throw PerchError.validation(error.message, { field });
    throw error;
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Headers that are the caller's credentials, and so never follow a redirect to another origin. */
const CREDENTIALS = ["authorization", "cookie", "proxy-authorization"];

/**
 * A fetch that makes every hop through checkOutbound. Redirects are followed by hand so each
 * location is checked; a caller that asked for `redirect: "manual"` gets the 3xx back as it came.
 */
export function outboundFetch(options: OutboundOptions = {}): FetchLike {
  const transport: FetchLike = options.transport ?? ((input, init) => fetch(input, init));
  const maxBytes = options.maxBytes ?? OUTBOUND_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? OUTBOUND_MAX_REDIRECTS;
  return async (input, init = {}) => {
    const deadline = AbortSignal.timeout(options.timeoutMs ?? OUTBOUND_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const mode = init.redirect ?? "follow";
    const headers = new Headers(init.headers);
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    let url = input;
    for (let hop = 0; ; hop += 1) {
      const target = await checkOutbound(url, options);
      const response = await transport(target.href, {
        ...init,
        method,
        headers: Object.fromEntries(headers.entries()),
        ...(body === undefined || body === null ? { body: null } : { body }),
        signal,
        redirect: "manual",
      });
      const location = response.headers.get("location");
      if (mode === "manual" || !REDIRECTS.has(response.status) || !location) {
        return capped(response, maxBytes, target.href);
      }
      await response.body?.cancel().catch(() => {});
      if (mode === "error") {
        throw new OutboundRefused("the answer was a redirect", target.href, "limit");
      }
      if (hop >= maxRedirects) {
        throw new OutboundRefused("too many redirects", target.href, "limit");
      }
      const next = new URL(location, target);
      const toGet =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST");
      if (toGet) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      } else if (body instanceof ReadableStream) {
        throw new OutboundRefused("a streamed body cannot follow a redirect", target.href, "limit");
      }
      if (next.origin !== target.origin) for (const name of CREDENTIALS) headers.delete(name);
      url = next.href;
    }
  };
}

/** The answer, with its body read no further than `maxBytes`. */
function capped(response: Response, maxBytes: number, url: string): Response {
  if (!response.body) return response;
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body.cancel().catch(() => {});
    throw new OutboundRefused(`the answer is larger than ${maxBytes} bytes`, url, "limit");
  }
  let seen = 0;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(
          new OutboundRefused(`the answer is larger than ${maxBytes} bytes`, url, "limit"),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(limit), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Whether two URLs name the same place: scheme and host compared case-insensitively, default ports
 * dropped, and a trailing slash on the path ignored. Used to tell a manifest's own endpoint from a
 * member's override of it.
 */
export function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    const left = new URL(a);
    const right = new URL(b);
    const path = (url: URL) => url.pathname.replace(/\/+$/, "");
    return (
      left.protocol === right.protocol &&
      left.host === right.host &&
      path(left) === path(right) &&
      left.search === right.search
    );
  } catch {
    return false;
  }
}
