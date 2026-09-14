---
"@perch/jobs": patch
"@perch/api": patch
---

The jobs worker no longer crashes at boot in team mode: the claim query binds its timestamps through the
column encoders instead of interpolating Dates into a raw sql template, which postgres.js could not
serialize under drizzle's transparent timestamp serializers. The queue suite now runs on Postgres as
well as PGlite in CI.
