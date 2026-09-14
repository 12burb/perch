import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { vector } from "@electric-sql/pglite-pgvector";

/**
 * Spike 0.4.4 — PGlite (spec §9.3).
 * Pass: the vector extension, tsvector generated columns with GIN, citext, and SKIP LOCKED queries all run
 * in memory, so packages/db can run its suite on PGlite (task 0.5) and laptop mode needs no embedded
 * Postgres. Outcome recorded in DECISIONS.md (ADR-0032).
 */

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector, citext } });
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS citext;");
}, 60_000);

afterAll(async () => {
  await pg.close();
}, 30_000);

describe("spike 0.4.4 PGlite in memory", () => {
  test("vector(1024) with an HNSW index answers a nearest-neighbour query", async () => {
    await pg.exec(`
      CREATE TABLE bot_memories (id text PRIMARY KEY, content text NOT NULL, embedding vector(1024));
      CREATE INDEX bot_memories_embedding_idx ON bot_memories USING hnsw (embedding vector_cosine_ops);
    `);
    const unit = (i: number) => {
      const v = new Array<number>(1024).fill(0);
      v[i] = 1;
      return `[${v.join(",")}]`;
    };
    await pg.query("INSERT INTO bot_memories VALUES ($1, $2, $3), ($4, $5, $6)", [
      "a",
      "alpha",
      unit(0),
      "b",
      "beta",
      unit(1),
    ]);
    const near = await pg.query<{ id: string }>(
      "SELECT id FROM bot_memories ORDER BY embedding <=> $1 LIMIT 1",
      [unit(1)],
    );
    expect(near.rows[0]?.id).toBe("b");
    const dims = await pg.query<{ d: number }>(
      "SELECT vector_dims(embedding) AS d FROM bot_memories LIMIT 1",
    );
    expect(dims.rows[0]?.d).toBe(1024);
  });

  test("a generated tsvector column with a GIN index serves full-text search", async () => {
    await pg.exec(`
      CREATE TABLE messages (
        id text PRIMARY KEY,
        body text NOT NULL,
        text_search tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED
      );
      CREATE INDEX messages_text_search_idx ON messages USING gin (text_search);
      INSERT INTO messages VALUES ('1', 'the agent opened a pull request'), ('2', 'lunch is at noon');
    `);
    const hits = await pg.query<{ id: string }>(
      "SELECT id FROM messages WHERE text_search @@ plainto_tsquery('english', $1)",
      ["pull requests"],
    );
    expect(hits.rows.map((r) => r.id)).toEqual(["1"]);
  });

  test("citext compares case-insensitively and enforces unique handles", async () => {
    await pg.exec("CREATE TABLE users (id text PRIMARY KEY, handle citext UNIQUE NOT NULL);");
    await pg.query("INSERT INTO users VALUES ('1', 'Dawn')");
    const found = await pg.query<{ id: string }>("SELECT id FROM users WHERE handle = $1", [
      "dAWN",
    ]);
    expect(found.rows[0]?.id).toBe("1");
    await expect(pg.query("INSERT INTO users VALUES ('2', 'DAWN')")).rejects.toThrow(/unique/i);
  });

  test("FOR UPDATE SKIP LOCKED claims a job inside a transaction", async () => {
    await pg.exec(`
      CREATE TABLE jobs (
        id text PRIMARY KEY, queue text NOT NULL, run_at timestamptz NOT NULL DEFAULT now(),
        locked_by text, locked_at timestamptz
      );
      CREATE INDEX jobs_queue_run_at_idx ON jobs (queue, run_at) WHERE locked_at IS NULL;
      INSERT INTO jobs (id, queue) VALUES ('j1', 'default'), ('j2', 'default');
    `);
    const claimed = await pg.transaction(async (tx) => {
      const row = await tx.query<{ id: string }>(
        `UPDATE jobs SET locked_by = $1, locked_at = now()
         WHERE id = (
           SELECT id FROM jobs WHERE queue = $2 AND locked_at IS NULL AND run_at <= now()
           ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED
         ) RETURNING id`,
        ["worker-1", "default"],
      );
      return row.rows[0]?.id;
    });
    expect(claimed).toBe("j1");
    const remaining = await pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM jobs WHERE locked_at IS NULL",
    );
    expect(remaining.rows[0]?.n).toBe(1);
  });

  test("advisory locks are available for the boot-time migrator", async () => {
    const locked = await pg.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(424242) AS ok");
    expect(locked.rows[0]?.ok).toBe(true);
    await pg.query("SELECT pg_advisory_unlock(424242)");
  });
});
