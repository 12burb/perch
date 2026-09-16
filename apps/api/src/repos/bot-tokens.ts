/**
 * A bot's own credentials, as rows (spec §6 `bots`, §7.1 `.../bots (+ … tokens)`; task 2.19).
 *
 * Only the hash is stored. The token itself is shown once, when it is minted, and never again —
 * the same shape an api token has, for the same reason.
 */
import { type BotScope, type BotToken, type Db, schema } from "@perch/db";
import { and, asc, eq, isNull } from "drizzle-orm";

const { botTokens } = schema;

export async function insertBotToken(
  db: Db,
  values: {
    botId: string;
    workspaceId: string;
    name: string;
    tokenHash: string;
    hint: string;
    scopes: BotScope[];
    createdBy: string | null;
    expiresAt?: Date | null;
  },
): Promise<BotToken> {
  const [row] = await db
    .insert(botTokens)
    .values({
      botId: values.botId,
      workspaceId: values.workspaceId,
      name: values.name,
      tokenHash: values.tokenHash,
      hint: values.hint,
      scopes: values.scopes,
      createdBy: values.createdBy,
      expiresAt: values.expiresAt ?? null,
    })
    .returning();
  if (!row) throw new Error("insert bot_tokens returned no row");
  return row;
}

export function listBotTokens(db: Db, botId: string): Promise<BotToken[]> {
  return db
    .select()
    .from(botTokens)
    .where(and(eq(botTokens.botId, botId), isNull(botTokens.revokedAt)))
    .orderBy(asc(botTokens.createdAt));
}

export async function findBotTokenByHash(db: Db, tokenHash: string): Promise<BotToken | null> {
  const [row] = await db
    .select()
    .from(botTokens)
    .where(and(eq(botTokens.tokenHash, tokenHash), isNull(botTokens.revokedAt)))
    .limit(1);
  return row ?? null;
}

/** Revoking keeps the row: a token that was used is part of the record, even once it is dead. */
export async function revokeBotToken(db: Db, botId: string, id: string): Promise<boolean> {
  const [row] = await db
    .update(botTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(botTokens.id, id), eq(botTokens.botId, botId), isNull(botTokens.revokedAt)))
    .returning();
  return row !== undefined;
}

export async function touchBotToken(db: Db, id: string): Promise<void> {
  await db.update(botTokens).set({ lastUsedAt: new Date() }).where(eq(botTokens.id, id));
}
