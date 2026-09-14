---
"@perch/db": patch
---

packages/db: the spec §6 schema for identity, tenancy, projects and runners, chat, files, instance_settings, and better-auth's tables; Zod shapes for every jsonb column; one Db type over postgres.js and PGlite; embedded migrations applied under an advisory lock; a PGlite test harness.
