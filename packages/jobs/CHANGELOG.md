# @perch/jobs

## 0.0.1

### Patch Changes

- 027121b: Core packages: the spec §7 contracts as Zod (bus event catalog, WS protocol, runner JSON-RPC, EngineEvent, error shape); an in-process bus with per-topic replay; a Postgres job queue with SKIP LOCKED claims, backoff, cron, and crash recovery; envelope encryption with rotation. Adds the jobs table (migration 0002).
- 833ab7d: The jobs worker no longer crashes at boot in team mode: the claim query binds its timestamps through the
  column encoders instead of interpolating Dates into a raw sql template, which postgres.js could not
  serialize under drizzle's transparent timestamp serializers. The queue suite now runs on Postgres as
  well as PGlite in CI.
- Updated dependencies [027121b]
- Updated dependencies [85b6bb8]
- Updated dependencies [45c4eee]
- Updated dependencies [eaa6104]
- Updated dependencies [e05fb7a]
- Updated dependencies [62de53e]
  - @perch/db@0.0.1
