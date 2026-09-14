-- Custom migration: extensions the schema depends on (citext for case-insensitive text; pgvector for
-- 1024-dimensional embeddings). PGlite loads both from @electric-sql/pglite/contrib/citext and
-- @electric-sql/pglite-pgvector; the pgvector/pgvector:pg16 image ships both.
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;
