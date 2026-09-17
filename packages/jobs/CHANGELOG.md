# @perch/jobs

## 0.1.0

### Minor Changes

- c2a9d67: A bot's schedule now means the hour you meant. `timezone: Europe/London` on a bot reads
  `0 9 * * 1-5` as nine in the morning there, and follows it across a daylight-saving change; a zone
  name that does not exist is refused when the bot is saved. A firing Perch was down for runs late by
  default, up to an hour, and a bot whose message only makes sense on time can say `catch_up: false`.
  And a new schedules endpoint says, for each one, when it next fires and when it last did.

### Patch Changes

- Updated dependencies [82cb101]
- Updated dependencies [b579c03]
- Updated dependencies [f519b64]
- Updated dependencies [31b4dba]
- Updated dependencies [fe0a09f]
- Updated dependencies [c3fe0bd]
- Updated dependencies [5549cfd]
- Updated dependencies [a5fe8a8]
- Updated dependencies [7ccdff3]
- Updated dependencies [714f396]
- Updated dependencies [cf4673b]
- Updated dependencies [3ba2508]
- Updated dependencies [00f1986]
- Updated dependencies [c2a9d67]
- Updated dependencies [3fdf6c1]
- Updated dependencies [53b90b0]
- Updated dependencies [4c68089]
- Updated dependencies [50d8ab9]
- Updated dependencies [fd812c8]
  - @perch/db@0.2.0

## 0.0.2

### Patch Changes

- Updated dependencies [378589c]
- Updated dependencies [9246f90]
- Updated dependencies [ea3b91b]
- Updated dependencies [ed9f649]
- Updated dependencies [347ce60]
- Updated dependencies [9c29082]
- Updated dependencies [3318f0e]
- Updated dependencies [7ffcb04]
- Updated dependencies [2918dc6]
- Updated dependencies [a837eea]
- Updated dependencies [3417ea3]
- Updated dependencies [f39b87d]
- Updated dependencies [0985050]
- Updated dependencies [f3aefb9]
- Updated dependencies [eb5cdaa]
- Updated dependencies [52af50e]
- Updated dependencies [8d7d282]
- Updated dependencies [9b25388]
- Updated dependencies [3764521]
- Updated dependencies [cc5c90d]
- Updated dependencies [365bdc5]
- Updated dependencies [a438fc6]
  - @perch/db@0.1.0

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
