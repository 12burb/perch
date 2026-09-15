/**
 * Share links (spec §5.6: "expiring, revocable, optionally public link card in a thread, never with
 * the inspector injected"; task 1.18).
 *
 * A share is a random token the holder keeps and a SHA-256 of it that Perch keeps — the same trade
 * as an api token (`preview_shares.token_hash` is unique, spec §6). Perch cannot show a share link
 * twice, and a database that leaks does not hand anyone a live preview.
 */

const encoder = new TextEncoder();

/** 32 bytes, base64url: enough that guessing is not a strategy. */
export function mintShareToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** What goes in the database. Hex, so a human comparing two rows can. */
export async function hashShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type ShareRecord = {
  workspaceId: string;
  projectId: string;
  runnerId: string;
  port: number;
  path: string;
  public: boolean;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type ShareVerdict =
  | { ok: true }
  | { ok: false; reason: "revoked" | "expired" | "wrong_port" | "wrong_workspace" };

/**
 * Whether a share may answer for this request. A share is for one port in one workspace: a token
 * for port 5173 is not a key to the runner.
 */
export function shareAllows(
  share: ShareRecord,
  request: { workspaceId: string; port: number },
  now: Date = new Date(),
): ShareVerdict {
  if (share.revokedAt) return { ok: false, reason: "revoked" };
  if (share.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (share.workspaceId !== request.workspaceId) return { ok: false, reason: "wrong_workspace" };
  if (share.port !== request.port) return { ok: false, reason: "wrong_port" };
  return { ok: true };
}

/** How long a share lasts when nobody says: long enough to review, short enough to forget about. */
export const SHARE_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000;
export const SHARE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
