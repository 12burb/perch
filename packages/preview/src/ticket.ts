/**
 * Preview tickets (spec §5.6 "gated by the Perch session"; task 1.18, ADR-0084).
 *
 * Wildcard mode gives each port an origin of its own, which is the whole point — and the reason a
 * Perch session cookie does not reach it. So a member's browser is let in the same way a share
 * link's holder is: a short-lived token on the URL once, exchanged for a cookie on that origin, and
 * the dev server's own links work from there.
 *
 * The ticket says who, which workspace, which port, and until when. It is signed with the api's
 * session secret and lives minutes, not hours: it exists to open one preview, not to be kept.
 */

const encoder = new TextEncoder();

export type PreviewTicket = {
  ws: string;
  user: string;
  port: number;
  /** Epoch milliseconds. */
  exp: number;
};

/** Long enough to open a preview and reload it a few times; short enough to be worthless later. */
export const TICKET_MS = 15 * 60 * 1000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function mintPreviewTicket(secret: string, claims: PreviewTicket): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/** The claims, if the signature holds and the ticket has not expired. Null otherwise. */
export async function verifyPreviewTicket(
  secret: string,
  token: string,
): Promise<PreviewTicket | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = fromBase64Url(token.slice(dot + 1));
  if (!signature) return null;
  const ok = await crypto.subtle.verify("HMAC", await key(secret), signature, encoder.encode(body));
  if (!ok) return null;
  const raw = fromBase64Url(body);
  if (!raw) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(raw)) as PreviewTicket;
    if (typeof claims.exp !== "number" || claims.exp <= Date.now()) return null;
    if (typeof claims.ws !== "string" || typeof claims.user !== "string") return null;
    if (typeof claims.port !== "number") return null;
    return claims;
  } catch {
    return null;
  }
}

/** The query parameter a member's preview URL carries once, before it becomes a cookie. */
export const TICKET_QUERY = "perch_preview";

/** The cookie that keeps a member in across the dev server's own navigations, on that origin. */
export const TICKET_COOKIE = "perch_preview_ticket";
