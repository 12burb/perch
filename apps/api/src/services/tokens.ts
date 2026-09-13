import type { ApiToken, ApiTokenScopes, Db } from "@perch/db";
import { PerchError } from "../errors.ts";
import {
  deleteToken,
  findTokenByHash,
  insertToken,
  listTokensForUser,
  touchToken,
} from "../repos/tokens.ts";

export const TOKEN_PREFIX = "pat_";

export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${TOKEN_PREFIX}${Buffer.from(bytes).toString("base64url")}`;
}

export type CreatedToken = { token: string; row: ApiToken };

/** Creates an api token; the plaintext is returned exactly once and only its hash is stored. */
export async function createApiToken(
  db: Db,
  input: {
    userId: string;
    name: string;
    scopes: ApiTokenScopes;
    workspaceId?: string | null;
    expiresAt?: Date | null;
  },
): Promise<CreatedToken> {
  const token = randomToken();
  const row = await insertToken(db, {
    userId: input.userId,
    workspaceId: input.workspaceId ?? null,
    name: input.name,
    tokenHash: hashToken(token),
    scopes: input.scopes,
    expiresAt: input.expiresAt ?? null,
  });
  return { token, row };
}

export function listApiTokens(db: Db, userId: string): Promise<ApiToken[]> {
  return listTokensForUser(db, userId);
}

export async function revokeApiToken(db: Db, userId: string, id: string): Promise<void> {
  if (!(await deleteToken(db, userId, id))) throw PerchError.notFound("token");
}

export type ResolvedToken = { userId: string; scopes: ApiTokenScopes; workspaceId: string | null };

/** Looks a bearer token up by hash; expired or unknown tokens resolve to null. */
export async function resolveApiToken(db: Db, token: string): Promise<ResolvedToken | null> {
  const row = await findTokenByHash(db, hashToken(token));
  if (!row) return null;
  const now = new Date();
  if (row.expiresAt && row.expiresAt.getTime() < now.getTime()) return null;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
    await touchToken(db, row.id, now);
  }
  return { userId: row.userId, scopes: row.scopes, workspaceId: row.workspaceId };
}
