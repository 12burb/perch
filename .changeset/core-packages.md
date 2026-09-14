---
"@perch/events": patch
"@perch/bus": patch
"@perch/jobs": patch
"@perch/vault": patch
"@perch/db": patch
---

Core packages: the spec §7 contracts as Zod (bus event catalog, WS protocol, runner JSON-RPC, EngineEvent, error shape); an in-process bus with per-topic replay; a Postgres job queue with SKIP LOCKED claims, backoff, cron, and crash recovery; envelope encryption with rotation. Adds the jobs table (migration 0002).
