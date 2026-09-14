import { type ApiToken, type ApiTokenScopes, type Db, schema } from "@perch/db";
import { and, eq } from "drizzle-orm";

const { apiTokens } = schema;

export async function insertToken(
  db: Db,
  values: {
    userId: string;
    workspaceId: string | null;
    name: string;
    tokenHash: string;
    scopes: ApiTokenScopes;
    expiresAt: Date | null;
  },
): Promise<ApiToken> {
  const [row] = await db.insert(apiTokens).values(values).returning();
  if (!row) throw new Error("token insert returned no row");
  return row;
}

export async function listTokensForUser(db: Db, userId: string): Promise<ApiToken[]> {
  return db.select().from(apiTokens).where(eq(apiTokens.userId, userId));
}

export async function findTokenByHash(db: Db, tokenHash: string): Promise<ApiToken | null> {
  const [row] = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export async function deleteToken(db: Db, userId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
    .returning({ id: apiTokens.id });
  return deleted.length > 0;
}

export async function touchToken(db: Db, id: string, at: Date): Promise<void> {
  await db.update(apiTokens).set({ lastUsedAt: at }).where(eq(apiTokens.id, id));
}
