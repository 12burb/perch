/**
 * The codebase index, as rows (spec §6 `repo_index`; task 2.17).
 *
 * Two ways to ask it a question, and one shape of answer. The words go through the generated
 * tsvector; the meaning goes through the embedding when a workspace has one. Everything is scoped
 * to a project, and a reindex replaces a commit rather than accumulating.
 */
import { type Db, type RepoChunk, schema } from "@perch/db";
import { and, eq, ne, sql } from "drizzle-orm";

const { repoIndex } = schema;

export type IndexedChunk = {
  projectId: string;
  commitSha: string;
  path: string;
  chunkNo: number;
  kind: "symbol" | "chunk" | "doc";
  symbol?: string | null;
  startLine: number;
  endLine: number;
  content: string;
  embedding?: number[] | null;
};

/** How many rows go in one statement; PGlite and Postgres both dislike very wide inserts. */
const BATCH = 200;

export async function insertChunks(db: Db, chunks: readonly IndexedChunk[]): Promise<number> {
  let written = 0;
  for (let at = 0; at < chunks.length; at += BATCH) {
    const slice = chunks.slice(at, at + BATCH);
    if (slice.length === 0) continue;
    await db
      .insert(repoIndex)
      .values(
        slice.map((one) => ({
          projectId: one.projectId,
          commitSha: one.commitSha,
          path: one.path,
          chunkNo: one.chunkNo,
          kind: one.kind,
          symbol: one.symbol ?? null,
          startLine: one.startLine,
          endLine: one.endLine,
          content: one.content,
          embedding: one.embedding ?? null,
        })),
      )
      // A file read twice at the same commit is the same row; the newer content wins.
      .onConflictDoUpdate({
        target: [repoIndex.projectId, repoIndex.path, repoIndex.chunkNo, repoIndex.commitSha],
        set: {
          kind: sql`excluded.kind`,
          symbol: sql`excluded.symbol`,
          startLine: sql`excluded.start_line`,
          endLine: sql`excluded.end_line`,
          content: sql`excluded.content`,
          embedding: sql`excluded.embedding`,
          updatedAt: new Date(),
        },
      });
    written += slice.length;
  }
  return written;
}

/** What an older commit left behind, once a newer one has been written in full. */
export async function dropOtherCommits(
  db: Db,
  projectId: string,
  commitSha: string,
): Promise<void> {
  await db
    .delete(repoIndex)
    .where(and(eq(repoIndex.projectId, projectId), ne(repoIndex.commitSha, commitSha)));
}

export type IndexStatus = {
  chunks: number;
  files: number;
  /** Null until something has been indexed. */
  commitSha: string | null;
  embedded: number;
  indexedAt: string | null;
};

export async function indexStatus(db: Db, projectId: string): Promise<IndexStatus> {
  const [row] = await db
    .select({
      chunks: sql<number>`count(*)::int`,
      files: sql<number>`count(distinct ${repoIndex.path})::int`,
      commitSha: sql<string | null>`max(${repoIndex.commitSha})`,
      embedded: sql<number>`count(${repoIndex.embedding})::int`,
      indexedAt: sql<string | null>`max(${repoIndex.updatedAt})`,
    })
    .from(repoIndex)
    .where(eq(repoIndex.projectId, projectId));
  return {
    chunks: row?.chunks ?? 0,
    files: row?.files ?? 0,
    commitSha: row?.commitSha ?? null,
    embedded: row?.embedded ?? 0,
    indexedAt: row?.indexedAt ? new Date(row.indexedAt).toISOString() : null,
  };
}

export type Hit = RepoChunk & { score: number };

/**
 * The words. `websearch_to_tsquery` takes what a person typed rather than a query language, so a
 * question with a comma in it is still a question.
 */
export async function searchWords(
  db: Db,
  input: { projectId: string; query: string; limit: number },
): Promise<Hit[]> {
  const query = sql`websearch_to_tsquery('english', ${input.query})`;
  const rows = await db
    .select({
      row: repoIndex,
      score: sql<number>`ts_rank(${repoIndex.textSearch}, ${query})`,
    })
    .from(repoIndex)
    .where(and(eq(repoIndex.projectId, input.projectId), sql`${repoIndex.textSearch} @@ ${query}`))
    .orderBy(sql`ts_rank(${repoIndex.textSearch}, ${query}) desc`)
    .limit(input.limit);
  return rows.map((one) => ({ ...one.row, score: Number(one.score) }));
}

export type CodeHit = Hit & { projectName: string; projectKey: string };

/**
 * The same words, across every project of a workspace (spec §5.7 "semantic search across code,
 * chat, docs"; task 2.17). The search page asks one question of everything a person can see, so the
 * code lane has to answer without being told which project to look in.
 */
export async function searchWorkspaceWords(
  db: Db,
  input: { workspaceId: string; query: string; limit: number },
): Promise<CodeHit[]> {
  const query = sql`websearch_to_tsquery('english', ${input.query})`;
  const rows = await db
    .select({
      row: repoIndex,
      projectName: schema.projects.name,
      projectKey: schema.projects.key,
      score: sql<number>`ts_rank(${repoIndex.textSearch}, ${query})`,
    })
    .from(repoIndex)
    .innerJoin(schema.projects, eq(schema.projects.id, repoIndex.projectId))
    .where(
      and(
        eq(schema.projects.workspaceId, input.workspaceId),
        sql`${repoIndex.textSearch} @@ ${query}`,
      ),
    )
    .orderBy(sql`ts_rank(${repoIndex.textSearch}, ${query}) desc`)
    .limit(input.limit);
  return rows.map((one) => ({
    ...one.row,
    projectName: one.projectName,
    projectKey: one.projectKey,
    score: Number(one.score),
  }));
}

/** The meaning. Cosine distance, nearest first, and only over rows that have a vector. */
export async function searchVector(
  db: Db,
  input: { projectId: string; embedding: number[]; limit: number },
): Promise<Hit[]> {
  // Bound as a parameter and cast, never interpolated (ADR-0061); the same shape bot_memories uses.
  const vector = sql`${JSON.stringify(input.embedding)}::vector`;
  const rows = await db
    .select({
      row: repoIndex,
      score: sql<number>`1 - (${repoIndex.embedding} <=> ${vector})`,
    })
    .from(repoIndex)
    .where(and(eq(repoIndex.projectId, input.projectId), sql`${repoIndex.embedding} is not null`))
    .orderBy(sql`${repoIndex.embedding} <=> ${vector}`)
    .limit(input.limit);
  return rows.map((one) => ({ ...one.row, score: Number(one.score) }));
}
