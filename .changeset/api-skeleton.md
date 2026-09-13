---
"@perch/api": patch
"@perch/api-client": patch
---

apps/api skeleton: Hono + zod-openapi with the OpenAPI document at /api/openapi.json, the §7.8 error model with request ids, pino request logging with secret redaction, Perch-Version handling, GET /api/health and /api/version, boot wiring (env → db migrations → bus, vault, queue), and the generated TypeScript client (@perch/api-client) typed end to end.
