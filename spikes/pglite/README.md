# Spike 0.4.4 — PGlite

**Pass criterion:** vector extension + tsvector + SKIP LOCKED queries pass the packages/db suite in memory.

**Outcome (ADR-0032): pass.** `@electric-sql/pglite` 0.5.8 in memory runs pgvector (`vector(1024)`, HNSW
index, `<=>` nearest neighbour; the extension ships as `@electric-sql/pglite-pgvector` 0.0.9 in this PGlite
line), a generated `tsvector` column with a GIN index and `plainto_tsquery`, `citext` (from
`@electric-sql/pglite/contrib/citext`), `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` inside a
transaction, and `pg_try_advisory_lock` for the boot-time migrator. First-run extension loading takes a few
seconds, so hooks carry explicit timeouts.

```sh
bun test spikes/pglite
```

Consequence for task 0.5: the packages/db suite runs on PGlite in memory; no embedded Postgres for laptop
mode. PGlite is single-connection, so concurrent SKIP LOCKED claims are exercised on real Postgres in the
CI service container.
