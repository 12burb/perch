import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { id, timestamps, tsvector } from "../columns.ts";
import { projects } from "./projects.ts";

/**
 * What Perch knows about a repository (spec §5.7 "codebase index (symbols + embeddings in pgvector)
 * behind @codebase"; §6 `repo_index`; task 2.17).
 *
 * One row per chunk of one file at one commit. Two ways in: the words, through the generated
 * tsvector, and the meaning, through the embedding — which is null until a workspace names a brain
 * to embed with, so an index is useful on a Perch with no embedding model at all (ADR-0110).
 */
export const REPO_CHUNK_KINDS = ["symbol", "chunk", "doc"] as const;
export type RepoChunkKind = (typeof REPO_CHUNK_KINDS)[number];

export const repoIndex = pgTable(
  "repo_index",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The commit the file was read at, so a reindex can drop what it replaced. */
    commitSha: text("commit_sha").notNull(),
    path: text("path").notNull(),
    chunkNo: integer("chunk_no").notNull(),
    kind: text("kind").$type<RepoChunkKind>().notNull(),
    /** The name a `symbol` chunk declares, when the file's language made one findable. */
    symbol: text("symbol"),
    /** Where in the file it is, so an answer can cite `path:line`. */
    startLine: integer("start_line").notNull().default(1),
    endLine: integer("end_line").notNull().default(1),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    textSearch: tsvector("text_search").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(symbol, '') || ' ' || path || ' ' || content)`,
    ),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("repo_index_project_path_chunk_idx").on(
      t.projectId,
      t.path,
      t.chunkNo,
      t.commitSha,
    ),
    index("repo_index_project_idx").on(t.projectId, t.commitSha),
    index("repo_index_text_idx").using("gin", t.textSearch),
    index("repo_index_embedding_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
      .where(sql`${t.embedding} is not null`),
    check("repo_index_kind_check", sql`${t.kind} in ('symbol', 'chunk', 'doc')`),
  ],
);

export type RepoChunk = typeof repoIndex.$inferSelect;
export type NewRepoChunk = typeof repoIndex.$inferInsert;
