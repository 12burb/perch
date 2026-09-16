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

/**
 * The time out of a header that may be a list. Stripe sends `t=1700000000,v1=<hex>` in one header,
 * so the timestamp is an entry in it rather than a header of its own (task 3.11).
 */
function timeOf(raw: string, prefix: string | undefined): string {
  if (!prefix) return raw.trim();
  const found = raw
    .split(/[\s,]+/)
    .map((one) => one.trim())
    .find((one) => one.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
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
  return hex(bytes);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Bytes out of a hex string, or null when it is not one — a pasted key is often not one. */
function unhex(value: string): Uint8Array | null {
  const clean = value.trim().toLowerCase();
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let at = 0; at < bytes.length; at += 1) {
    bytes[at] = Number.parseInt(clean.slice(at * 2, at * 2 + 2), 16);
  }
  return bytes;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unbase64url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (one) => one.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sha256Hex(body: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))));
}

/**
 * A keypair for an Ed25519 scheme, hex both halves: the public key is what somebody pastes into
 * Perch, the private key is the provider's own and only a test ever holds one (task 3.25).
 */
export async function ed25519Keypair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    publicKey: hex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: hex(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
  };
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

/** The HMAC this scheme would put in its header, for the bytes it says it signs. */
async function mac(scheme: WebhookScheme, signed: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encode(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)),
    scheme.encoding,
  );
}

/** What this scheme says is signed, with the delivery's own headers filled in. */
function signedText(
  scheme: WebhookScheme,
  headers: Headers | Record<string, string>,
  body: string,
): string {
  return scheme.signed
    .replaceAll("{body}", body)
    .replaceAll("{id}", scheme.id_header ? (header(headers, scheme.id_header) ?? "") : "")
    .replaceAll(
      "{timestamp}",
      scheme.timestamp_header
        ? timeOf(header(headers, scheme.timestamp_header) ?? "", scheme.timestamp_prefix)
        : "",
    );
}

/**
 * The header value this provider would have sent, for a delivery Perch is making up — which is
 * what a test needs, and what the manifest harness checks a scheme with (task 3.11). It is the
 * same bytes `verifyDelivery` recomputes, from the same manifest, so a scheme that signs nothing
 * cannot pass both.
 *
 * `secret` is whatever that scheme signs with, which is not always what it verifies with: an
 * Ed25519 provider signs with a private key and Perch holds only the public half (task 3.25).
 */
export async function signDelivery(input: {
  manifest: Pick<Manifest, "webhook_signature" | "webhook">;
  headers: Headers | Record<string, string>;
  body: string;
  secret: string;
}): Promise<string> {
  const scheme = input.manifest.webhook;
  const signed = signedText(scheme, input.headers, input.body);
  if (input.manifest.webhook_signature === "shared_secret") return input.secret;
  if (input.manifest.webhook_signature === "ed25519") {
    const key = unhex(input.secret);
    if (!key) throw new Error("an ed25519 scheme signs with a hex private key");
    const signer = await crypto.subtle.importKey("pkcs8", key, "Ed25519", false, ["sign"]);
    const signature = await crypto.subtle.sign("Ed25519", signer, new TextEncoder().encode(signed));
    return `${scheme.prefix}${hex(new Uint8Array(signature))}`;
  }
  if (input.manifest.webhook_signature === "jws_hs256") {
    return `${scheme.prefix}${await jws(input.body, input.secret)}`;
  }
  return `${scheme.prefix}${await mac(scheme, signed, input.secret)}`;
}

/** Netlify's compact JWS: `{alg: HS256}` over `{iss, sha256}`, where the sha256 is the body's. */
async function jws(body: string, secret: string): Promise<string> {
  const text = new TextEncoder();
  const head = base64url(text.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const claims = base64url(
    text.encode(JSON.stringify({ iss: "netlify", sha256: await sha256Hex(body) })),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    text.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, text.encode(`${head}.${claims}`));
  return `${head}.${claims}.${base64url(new Uint8Array(signature))}`;
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
    id: scheme.id_header ? header(input.headers, scheme.id_header) : null,
    event: scheme.event_header ? header(input.headers, scheme.event_header) : null,
  };
  if (input.manifest.webhook_signature === "none") return { ok: true, delivery };

  const raw = header(input.headers, scheme.header);
  if (!raw) return { ok: false, reason: `no ${scheme.header} on this delivery` };

  let timestamp = "";
  if (scheme.timestamp_header) {
    timestamp = timeOf(
      header(input.headers, scheme.timestamp_header) ?? "",
      scheme.timestamp_prefix,
    );
    const at = Number(timestamp) * (timestamp.length > 11 ? 1 : 1000);
    if (!Number.isFinite(at)) return { ok: false, reason: "that delivery has no readable time" };
    const drift = Math.abs((input.now ?? Date.now()) - at) / 1000;
    if (drift > scheme.tolerance_s) return { ok: false, reason: "that delivery is too old" };
  }

  const signed = scheme.signed
    .replaceAll("{body}", input.body)
    .replaceAll("{id}", delivery.id ?? "")
    .replaceAll("{timestamp}", timestamp);
  const candidates = offered(raw, scheme.prefix);

  // The secret is sent back as it is: this says who sent it and nothing about what they sent.
  if (input.manifest.webhook_signature === "shared_secret") {
    if (!candidates.some((one) => same(one, input.secret))) {
      return { ok: false, reason: "that secret is not this endpoint's" };
    }
    return { ok: true, delivery };
  }

  // Asymmetric: the key is the provider's public half, so a forgery needs their private one.
  if (input.manifest.webhook_signature === "ed25519") {
    const key = unhex(input.secret);
    if (key?.length !== 32) {
      return { ok: false, reason: "this endpoint has no usable public key" };
    }
    const verifier = await crypto.subtle
      .importKey("raw", key, "Ed25519", false, ["verify"])
      .catch(() => null);
    if (!verifier) return { ok: false, reason: "this endpoint has no usable public key" };
    const message = new TextEncoder().encode(signed);
    for (const candidate of candidates) {
      const bytes = unhex(candidate);
      if (bytes?.length !== 64) continue;
      if (await crypto.subtle.verify("Ed25519", verifier, bytes, message)) {
        return { ok: true, delivery };
      }
    }
    return { ok: false, reason: "that signature is not this provider's" };
  }

  // Netlify's JWS: verify the token, then check it is about this body.
  if (input.manifest.webhook_signature === "jws_hs256") {
    for (const candidate of candidates) {
      if (await jwsHolds(candidate, input.body, input.secret)) return { ok: true, delivery };
    }
    return { ok: false, reason: "that signature is not this instance's" };
  }

  const mine = await mac(scheme, signed, input.secret);
  if (!candidates.some((one) => same(one.toLowerCase(), mine.toLowerCase()))) {
    return { ok: false, reason: "that signature is not this instance's" };
  }
  return { ok: true, delivery };
}

/** Whether this compact JWS was signed with the secret and is about this body. */
async function jwsHolds(token: string, body: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  const [head, claims, signature] = parts;
  if (parts.length !== 3 || !head || !claims || !signature) return false;
  const offeredBytes = unbase64url(signature);
  if (!offeredBytes) return false;
  const text = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    text.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signedOver = text.encode(`${head}.${claims}`);
  if (!(await crypto.subtle.verify("HMAC", key, offeredBytes, signedOver))) return false;
  const payload = unbase64url(claims);
  if (!payload) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return false;
  }
  const digest = (parsed as { sha256?: unknown } | null)?.sha256;
  // A token that says nothing about the body would let any body through with one real signature.
  if (typeof digest !== "string") return false;
  return same(digest.toLowerCase(), (await sha256Hex(body)).toLowerCase());
}

/** What Perch hands somebody to paste into the provider: 32 bytes, hex. */
export function webhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
