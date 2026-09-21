/**
 * Search (spec §5.2 "Postgres full-text over messages and files with filters", §7.1
 * `/api/workspaces/{ws}/search?q&type`; task 2.4).
 *
 * Postgres does the work: `messages.text_search` is a generated tsvector with a GIN index on it
 * (task 0.5), so a query is one index scan and a rank. Nothing is indexed twice and there is no
 * search service to run (spec §3.1).
 *
 * Every query is scoped to what the caller can see before it is scoped to what they asked for: the
 * channels they are in plus the public ones, and — for files — the messages in those channels that
 * point at them.
 */
import type { Db, FileRow, Message } from "@perch/db";
import { schema } from "@perch/db";
import { and, desc, eq, exists, inArray, isNull, or, sql } from "drizzle-orm";
import { memberChannelIds } from "./channels.ts";

const { channels, files, messages, users } = schema;

export type MessageHit = {
  message: Message;
  channelId: string;
  channelName: string | null;
  authorName: string | null;
  rank: number;
};

export type FileHit = { file: FileRow; channelId: string | null; channelName: string | null };

/**
 * What the caller typed, bound as text (ADR-0061). A search term is not a column value, so it has
 * no column encoder of its own; `::text` says what it is to `websearch_to_tsquery`.
 */
function term(q: string) {
  return sql`${q}::text`;
}

/**
 * `websearch_to_tsquery` is the one that takes what people actually type — bare words, "quoted
 * phrases", `or`, and a leading `-` for "not" — without throwing on punctuation.
 */
function tsquery(q: string) {
  return sql`websearch_to_tsquery('english', ${term(q)})`;
}

/** The block a message carries when it points at this file. */
function fileBlock(fileId: unknown) {
  return sql`jsonb_build_array(jsonb_build_object('type', 'file', 'fileId', ${fileId}::text))`;
}

/** The channels a query may look in: the public ones and the ones the caller is in. */
export async function visibleChannelIds(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<string[]> {
  const mine = await memberChannelIds(db, userId);
  const visible = mine.length
    ? or(eq(channels.type, "public"), inArray(channels.id, mine))
    : eq(channels.type, "public");
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), visible));
  return rows.map((row) => row.id);
}

export type MessageSearch = {
  workspaceId: string;
  q: string;
  /** The channels this caller may look in; the service has already refused any other. */
  scope: string[];
  authorId?: string | undefined;
  limit?: number | undefined;
};

export async function searchMessages(db: Db, input: MessageSearch): Promise<MessageHit[]> {
  if (input.scope.length === 0) return [];
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const where = [
    eq(messages.workspaceId, input.workspaceId),
    isNull(messages.deletedAt),
    inArray(messages.channelId, input.scope),
    sql`${messages.textSearch} @@ ${tsquery(input.q)}`,
  ];
  if (input.authorId) where.push(eq(messages.authorId, input.authorId));

  /**
   * Two steps on purpose. A common word matches tens of thousands of messages, and ranking is only
   * cheap when what is being ranked and sorted is a pair of columns: the first query picks the ids,
   * the second fetches those rows and the names beside them. Ranking whole rows — blocks, tsvector
   * and all — and sorting them costs about five times as much on 100k messages (ADR-0094).
   */
  const rank = sql<number>`ts_rank_cd(${messages.textSearch}, ${tsquery(input.q)})`.as("rank");
  const hits = db
    .select({ id: messages.id, rank })
    .from(messages)
    .where(and(...where))
    // Rank first, then newest: two messages that match equally well are read newest first.
    .orderBy(desc(rank), desc(messages.id))
    .limit(limit)
    .as("hits");

  const rows = await db
    .select({
      message: messages,
      channelName: channels.name,
      authorName: users.name,
      rank: hits.rank,
    })
    .from(hits)
    .innerJoin(messages, eq(messages.id, hits.id))
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .leftJoin(users, and(eq(messages.authorType, "user"), eq(messages.authorId, users.id)))
    .orderBy(desc(hits.rank), desc(messages.id));
  return rows.map((row) => ({
    message: row.message,
    channelId: row.message.channelId,
    channelName: row.channelName,
    authorName: row.authorName,
    rank: Number(row.rank),
  }));
}

/** Is this file in front of this caller: their own upload, or said in a channel they can see? */
function reachable(db: Db, userId: string, scope: string[]) {
  const said = exists(
    db
      .select({ one: sql`1` })
      .from(messages)
      .where(
        and(
          isNull(messages.deletedAt),
          inArray(messages.channelId, scope),
          sql`${messages.blocks} @> ${fileBlock(files.id)}`,
        ),
      ),
  );
  return scope.length > 0 ? or(eq(files.uploaderId, userId), said) : eq(files.uploaderId, userId);
}

/**
 * Files by name, and only the ones the caller could have come across (ADR-0094 closes what
 * ADR-0093 left open). A name is short and a workspace has thousands of files, not millions, so
 * this is a plain case-insensitive match rather than a second full-text index.
 */
export async function searchFiles(
  db: Db,
  input: { workspaceId: string; userId: string; q: string; scope: string[]; limit?: number },
): Promise<FileHit[]> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const rows = await db
    .select({ file: files })
    .from(files)
    .where(
      and(
        eq(files.workspaceId, input.workspaceId),
        isNull(files.deletedAt),
        sql`${files.name} ilike ${`%${literal(input.q.trim())}%`}::text`,
        reachable(db, input.userId, input.scope),
      ),
    )
    .orderBy(desc(files.createdAt))
    .limit(limit);
  if (rows.length === 0 || input.scope.length === 0) {
    return rows.map((row) => ({ file: row.file, channelId: null, channelName: null }));
  }

  // Where each one was said, for the line under the result.
  const out: FileHit[] = [];
  for (const row of rows) {
    const [said] = await db
      .select({ channelId: messages.channelId, channelName: channels.name })
      .from(messages)
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .where(
        and(
          isNull(messages.deletedAt),
          inArray(messages.channelId, input.scope),
          sql`${messages.blocks} @> ${fileBlock(sql`${row.file.id}`)}`,
        ),
      )
      .limit(1);
    out.push({
      file: row.file,
      channelId: said?.channelId ?? null,
      channelName: said?.channelName ?? null,
    });
  }
  return out;
}

/**
 * May this person read this file? The uploader always; anybody else only through a message in a
 * channel they can see. That is what makes a private channel's attachments as private as its
 * messages (ADR-0094). A file nobody has said yet is its uploader's alone.
 */
export async function canReadFile(
  db: Db,
  file: FileRow,
  userId: string,
  scope: string[],
): Promise<boolean> {
  if (file.uploaderType === "user" && file.uploaderId === userId) return true;
  if (scope.length === 0) return false;
  const [hit] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        isNull(messages.deletedAt),
        inArray(messages.channelId, scope),
        sql`${messages.blocks} @> ${fileBlock(sql`${file.id}`)}`,
      ),
    )
    .limit(1);
  return Boolean(hit);
}

/** `%` and `_` mean something in `like`, and a person typing them means the characters. */
function literal(term: string): string {
  return term.replace(/[\\%_]/g, (one) => `\\${one}`);
}
