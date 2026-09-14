/**
 * Per-request capability tokens for the runner protocol (spec §7.6): every api → runner request
 * carries `cap`, an HMAC-SHA256 token over {ws, user, method, exp} minted with the secret the api handed
 * the runner when it registered. The runner verifies it before dispatching, so a request reaches a
 * handler only with the workspace, user, and method the api bound it to, and only while it is fresh.
 * Web Crypto only: this module is shared by the api, the runner, and the browser bundle.
 */

export type CapClaims = {
  /** workspace_id */
  ws: string;
  /** user_id */
  user: string;
  method: string;
  /** Expiry, ms since the epoch. */
  exp: number;
};

export type CapVerdict =
  | { ok: true; claims: CapClaims }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "mismatch" };

/** Default lifetime of a capability token. */
export const CAP_TTL_MS = 60_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** A fresh per-connection secret (32 random bytes, base64url). */
export function generateCapSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function mintCap(secret: string, claims: CapClaims): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(payload),
  );
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Verifies the signature (constant time), the expiry, and that the claims name the request's
 * workspace, user, and method.
 */
export async function verifyCap(
  secret: string,
  token: string,
  expected: { ws: string; user: string; method: string },
  now: number = Date.now(),
): Promise<CapVerdict> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed" };
  const payload = token.slice(0, dot);
  const signature = fromBase64Url(token.slice(dot + 1));
  const payloadBytes = fromBase64Url(payload);
  if (!signature || !payloadBytes) return { ok: false, reason: "malformed" };
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    encoder.encode(payload),
  );
  if (!valid) return { ok: false, reason: "signature" };
  let claims: CapClaims;
  try {
    const parsed: unknown = JSON.parse(decoder.decode(payloadBytes));
    if (!isClaims(parsed)) return { ok: false, reason: "malformed" };
    claims = parsed;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp <= now) return { ok: false, reason: "expired" };
  if (
    claims.ws !== expected.ws ||
    claims.user !== expected.user ||
    claims.method !== expected.method
  ) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, claims };
}

function isClaims(value: unknown): value is CapClaims {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ws === "string" &&
    typeof v.user === "string" &&
    typeof v.method === "string" &&
    typeof v.exp === "number"
  );
}
