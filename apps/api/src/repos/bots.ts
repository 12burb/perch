/**
 * bots, bot_installs, bot_runs and bot_memories (spec §6; task 2.6). The ledger is the point of
 * `bot_runs`: a budget is only real if what has been spent can be counted.
 */
import type {
  Bot,
  BotChain,
  BotInstall,
  BotMemory,
  BotRun,
  Db,
  NewBot,
  NewBotChain,
  NewBotRun,
} from "@perch/db";
import { schema } from "@perch/db";
import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";

const { bots, botInstalls, botRuns, botMemories, botChains, channels, channelMembers } = schema;

/** The bots this person can see: the workspace's own, plus their own private ones. */
export async function listBots(db: Db, workspaceId: string, userId: string): Promise<Bot[]> {
  return db
    .select()
    .from(bots)
    .where(
      and(
        eq(bots.workspaceId, workspaceId),
        or(eq(bots.visibility, "workspace"), eq(bots.ownerId, userId)),
      ),
    )
    .orderBy(asc(bots.handle));
}

export async function getBot(db: Db, id: string): Promise<Bot | null> {
  const [row] = await db.select().from(bots).where(eq(bots.id, id)).limit(1);
  return row ?? null;
}

export async function botByHandle(
  db: Db,
  workspaceId: string,
  handle: string,
): Promise<Bot | null> {
  const [row] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.workspaceId, workspaceId), eq(bots.handle, handle)))
    .limit(1);
  return row ?? null;
}

/** The names behind a page of messages, so a bot's line says who said it. */
export async function botsByIds(db: Db, ids: string[]): Promise<Map<string, Bot>> {
  const out = new Map<string, Bot>();
  if (ids.length === 0) return out;
  const rows = await db.select().from(bots).where(inArray(bots.id, ids));
  for (const row of rows) out.set(row.id, row);
  return out;
}

export async function insertBot(db: Db, values: NewBot): Promise<Bot> {
  const [row] = await db.insert(bots).values(values).returning();
  if (!row) throw new Error("bot insert returned no row");
  return row;
}

export async function updateBot(db: Db, id: string, values: Partial<NewBot>): Promise<Bot | null> {
  const [row] = await db.update(bots).set(values).where(eq(bots.id, id)).returning();
  return row ?? null;
}

export async function deleteBot(db: Db, id: string): Promise<void> {
  await db.delete(bots).where(eq(bots.id, id));
}

/** Putting a bot in a channel: the install, and the membership that lets it read and write. */
export async function installBot(
  db: Db,
  input: { botId: string; channelId: string; scopes?: BotInstall["scopes"] },
): Promise<BotInstall> {
  const [row] = await db
    .insert(botInstalls)
    .values({
      botId: input.botId,
      channelId: input.channelId,
      ...(input.scopes ? { scopes: input.scopes } : {}),
    })
    .onConflictDoUpdate({
      target: [botInstalls.botId, botInstalls.channelId],
      set: { scopes: input.scopes ?? {}, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("bot install returned no row");
  await db
    .insert(channelMembers)
    .values({ channelId: input.channelId, memberType: "bot", memberId: input.botId })
    .onConflictDoNothing();
  return row;
}

export async function uninstallBot(db: Db, botId: string, channelId: string): Promise<boolean> {
  const rows = await db
    .delete(botInstalls)
    .where(and(eq(botInstalls.botId, botId), eq(botInstalls.channelId, channelId)))
    .returning({ id: botInstalls.id });
  await db
    .delete(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.memberType, "bot"),
        eq(channelMembers.memberId, botId),
      ),
    );
  return rows.length > 0;
}

export async function installsOf(db: Db, botId: string): Promise<BotInstall[]> {
  return db.select().from(botInstalls).where(eq(botInstalls.botId, botId));
}

/** Every bot installed in this channel, with the install beside it. */
export async function botsInChannel(
  db: Db,
  channelId: string,
): Promise<{ bot: Bot; install: BotInstall }[]> {
  return db
    .select({ bot: bots, install: botInstalls })
    .from(botInstalls)
    .innerJoin(bots, eq(bots.id, botInstalls.botId))
    .where(eq(botInstalls.channelId, channelId));
}

/** The channel a bot may post in by name or id, but only where it has been installed. */
export async function channelForBot(
  db: Db,
  botId: string,
  nameOrId: string,
): Promise<{ id: string; name: string | null; workspaceId: string } | null> {
  const rows = await db
    .select({ id: channels.id, name: channels.name, workspaceId: channels.workspaceId })
    .from(botInstalls)
    .innerJoin(channels, eq(channels.id, botInstalls.channelId))
    .where(eq(botInstalls.botId, botId));
  const want = nameOrId.replace(/^#/, "").toLowerCase();
  return (
    rows.find((row) => row.id.toLowerCase() === want || row.name?.toLowerCase() === want) ?? null
  );
}

export async function startRun(db: Db, values: NewBotRun): Promise<BotRun> {
  const [row] = await db.insert(botRuns).values(values).returning();
  if (!row) throw new Error("bot run insert returned no row");
  return row;
}

export async function finishRun(
  db: Db,
  id: string,
  values: {
    status: BotRun["status"];
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    modelId?: string | null;
    error?: string | null;
  },
): Promise<BotRun | null> {
  const [row] = await db
    .update(botRuns)
    .set({
      status: values.status,
      endedAt: new Date(),
      ...(values.inputTokens === undefined ? {} : { inputTokens: values.inputTokens }),
      ...(values.outputTokens === undefined ? {} : { outputTokens: values.outputTokens }),
      ...(values.costUsd === undefined ? {} : { costUsd: values.costUsd.toFixed(6) }),
      ...(values.modelId === undefined ? {} : { modelId: values.modelId }),
      ...(values.error === undefined ? {} : { error: values.error }),
    })
    .where(eq(botRuns.id, id))
    .returning();
  return row ?? null;
}

export async function listRuns(db: Db, botId: string, limit = 50): Promise<BotRun[]> {
  return db
    .select()
    .from(botRuns)
    .where(eq(botRuns.botId, botId))
    .orderBy(desc(botRuns.startedAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** What this bot has spent since a moment, and how many times it has run since another. */
export async function spending(
  db: Db,
  botId: string,
  since: { day: Date; hour: Date },
): Promise<{ spentTodayUsd: number; runsThisHour: number }> {
  const [today] = await db
    .select({ total: sql<string>`coalesce(sum(${botRuns.costUsd}), 0)` })
    .from(botRuns)
    .where(and(eq(botRuns.botId, botId), gte(botRuns.startedAt, since.day)));
  const [hour] = await db
    .select({ runs: sql<number>`count(*)::int` })
    .from(botRuns)
    .where(and(eq(botRuns.botId, botId), gte(botRuns.startedAt, since.hour)));
  return {
    spentTodayUsd: Number(today?.total ?? 0),
    runsThisHour: Number(hour?.runs ?? 0),
  };
}

export async function keepMemory(
  db: Db,
  values: {
    botId: string;
    scope: string;
    content: string;
    embedding?: number[] | null;
    sourceMessageId?: string | null;
  },
): Promise<BotMemory> {
  const [row] = await db
    .insert(botMemories)
    .values({
      botId: values.botId,
      scope: values.scope,
      content: values.content,
      ...(values.embedding ? { embedding: values.embedding } : {}),
      ...(values.sourceMessageId ? { sourceMessageId: values.sourceMessageId } : {}),
    })
    .returning();
  if (!row) throw new Error("bot memory insert returned no row");
  return row;
}

/**
 * What the bot kept, nearest first. With an embedding that is cosine distance; without one it is
 * the words themselves, which is what a Perch with no embedding model has (ADR-0096).
 */
export async function recallMemories(
  db: Db,
  input: {
    botId: string;
    query: string;
    scopes: string[];
    embedding?: number[] | null;
    limit: number;
  },
): Promise<BotMemory[]> {
  const limit = Math.min(Math.max(input.limit, 1), 20);
  const where = [eq(botMemories.botId, input.botId)];
  if (input.scopes.length > 0) where.push(inArray(botMemories.scope, input.scopes));
  if (input.embedding) {
    return db
      .select()
      .from(botMemories)
      .where(and(...where, sql`${botMemories.embedding} is not null`))
      .orderBy(sql`${botMemories.embedding} <=> ${JSON.stringify(input.embedding)}::vector`)
      .limit(limit);
  }
  const words = input.query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((word) => word.length > 2)
    .slice(0, 8);
  if (words.length === 0) {
    return db
      .select()
      .from(botMemories)
      .where(and(...where))
      .orderBy(desc(botMemories.createdAt))
      .limit(limit);
  }
  const matches = words.map(
    (word) => sql`${botMemories.content} ilike ${sql.param(`%${word}%`, botMemories.content)}`,
  );
  return db
    .select()
    .from(botMemories)
    .where(and(...where, or(...matches)))
    .orderBy(desc(botMemories.createdAt))
    .limit(limit);
}

/** Every hop of one thread, oldest first: the chain as it happened (spec §5.4). */
export async function chainOf(db: Db, threadRootId: string): Promise<BotChain[]> {
  return db
    .select()
    .from(botChains)
    .where(eq(botChains.threadRootId, threadRootId))
    .orderBy(asc(botChains.createdAt), asc(botChains.id));
}

export async function startHop(db: Db, values: NewBotChain): Promise<BotChain> {
  const [row] = await db.insert(botChains).values(values).returning();
  if (!row) throw new Error("bot chain insert returned no row");
  return row;
}

export async function finishHop(
  db: Db,
  id: string,
  values: {
    status: BotChain["status"];
    tokens?: number;
    costUsd?: number;
    breakerReason?: string | null;
  },
): Promise<BotChain | null> {
  const [row] = await db
    .update(botChains)
    .set({
      status: values.status,
      ...(values.tokens === undefined ? {} : { tokens: values.tokens }),
      ...(values.costUsd === undefined ? {} : { costUsd: values.costUsd.toFixed(6) }),
      ...(values.breakerReason === undefined ? {} : { breakerReason: values.breakerReason }),
    })
    .where(eq(botChains.id, id))
    .returning();
  return row ?? null;
}

/** The bots of a workspace by handle, for a mention that names one. */
export async function botsByHandles(
  db: Db,
  workspaceId: string,
  handles: string[],
): Promise<Bot[]> {
  if (handles.length === 0) return [];
  return db
    .select()
    .from(bots)
    .where(and(eq(bots.workspaceId, workspaceId), inArray(bots.handle, handles)));
}
