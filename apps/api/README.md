# @perch/api

Hono on `Bun.serve`: the HTTP + WebSocket api, the supervisor and worker entrypoints (spec §3.1).

```sh
bun run --filter @perch/api dev        # watch mode on PGlite (laptop mode)
bun src/index.ts                       # api (HTTP + WS + in-process jobs worker)
bun src/index.ts worker                # jobs worker only
bun src/index.ts supervisor            # Docker supervisor (task 1.2)
```

| Path | What |
|---|---|
| `src/env.ts` | every `PERCH_*` variable with defaults, validated with Zod; laptop vs team mode |
| `src/errors.ts` | `PerchError(code, message, details, status)` and the §7.8 error handler |
| `src/logging.ts` | pino, one line per request with `request_id`, `workspace_id`, `user_id`; redaction |
| `src/app.ts` | the `OpenAPIHono` app: routes under `/api`, `/api/openapi.json`, `Perch-Version`, static web |
| `src/boot.ts` | env → db (migrations on boot) → bus, vault, queue → app |
| `src/routes/` | one file per resource, each a `createRoute` + handler pair |
| `scripts/export-openapi.ts` | writes `packages/api-client/openapi.json` for SDK generation |

Handlers → services → repositories (spec §9.1): no SQL in handlers, no HTTP in services.
