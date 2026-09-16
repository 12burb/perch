/**
 * Inbound webhooks (spec §3.5 "inbound webhooks at /hooks/:provider/:id with signature
 * verification → channel cards"; task 3.4).
 *
 * This is the half that decides whether a delivery is really from the provider. It is pure: headers
 * in, a verdict out, nothing read and nothing written — so the rule can be tested against real
 * signatures without a database, and the route that uses it has nothing to get wrong.
 *
 * What a provider signs and where it puts the signature comes from its manifest (ADR-0119), so a
 * connector stays a file.
 */
import type { Manifest, WebhookScheme } from "./manifest.ts";

export type Delivery = {
  /** The provider's own id for this delivery, which is how a replay is spotted. */
  id: string | null;
  /** What happened, as the provider names it: `push`, `deployment.succeeded`, `user.created`. */
  event: string | null;
};

export type Verdict = { ok: true; delivery: Delivery } | { ok: false; reason: string };

/** Case-insensitive, because a header name is. */
function header(headers: Headers | Record<string, string>, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

/** Constant time, so a wrong signature says nothing about how wrong it was. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let at = 0; at < a.length; at += 1) diff |= a.charCodeAt(at) ^ b.charCodeAt(at);
  return diff === 0;
}

function encode(mac: ArrayBuffer, encoding: WebhookScheme["encoding"]): string {
  const bytes = new Uint8Array(mac);
  if (encoding === "base64") return btoa(String.fromCharCode(...bytes));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Every signature in the header, without its prefix. Svix sends a space-separated list so a secret
 * can be rotated without dropping a delivery; GitHub sends one.
 */
function offered(raw: string, prefix: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((one) => one.trim())
    .filter(Boolean)
    .map((one) => (prefix && one.startsWith(prefix) ? one.slice(prefix.length) : one))
    .filter(Boolean);
}

/**
 * Whether this delivery is really from this provider. `secret` is the one Perch generated when the
 * webhook was made and the person pasted into the provider.
 */
export async function verifyDelivery(input: {
  manifest: Pick<Manifest, "webhook_signature" | "webhook">;
  headers: Headers | Record<string, string>;
  /** The raw body, exactly as it arrived: a re-serialized one is a different body. */
  body: string;
  secret: string;
  now?: number;
}): Promise<Verdict> {
  const scheme = input.manifest.webhook;
  const delivery: Delivery = {
    id: header(input.headers, scheme.id_header),
    event: header(input.headers, scheme.event_header),
  };
  if (input.manifest.webhook_signature === "none") return { ok: true, delivery };

  const raw = header(input.headers, scheme.header);
  if (!raw) return { ok: false, reason: `no ${scheme.header} on this delivery` };

  let timestamp = "";
  if (scheme.timestamp_header) {
    timestamp = header(input.headers, scheme.timestamp_header) ?? "";
    const at = Number(timestamp) * (timestamp.length > 11 ? 1 : 1000);
    if (!Number.isFinite(at)) return { ok: false, reason: "that delivery has no readable time" };
    const drift = Math.abs((input.now ?? Date.now()) - at) / 1000;
    if (drift > scheme.tolerance_s) return { ok: false, reason: "that delivery is too old" };
  }

  const signed = scheme.signed
    .replaceAll("{body}", input.body)
    .replaceAll("{id}", delivery.id ?? "")
    .replaceAll("{timestamp}", timestamp);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mine = encode(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)),
    scheme.encoding,
  );
  const candidates = offered(raw, scheme.prefix);
  if (!candidates.some((one) => same(one.toLowerCase(), mine.toLowerCase()))) {
    return { ok: false, reason: "that signature is not this instance's" };
  }
  return { ok: true, delivery };
}

/** What Perch hands somebody to paste into the provider: 32 bytes, hex. */
export function webhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
