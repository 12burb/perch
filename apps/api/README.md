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
| `src/auth/` | better-auth (`createAuth`: email + password, passkeys, generic OIDC) and the `authenticate` / `requireUser` middleware |
| `src/routes/` | one file per resource, each a `createRoute` + handler pair (`/api/me`, `/api/me/tokens`, `/api/workspaces`, `/api/invites`, `/api/instance`) |
| `src/services/` | pure functions over `Db` and `Bus` (profiles, api tokens, workspaces, invites) |
| `src/repos/` | Drizzle queries, workspace-scoped |
| `scripts/export-openapi.ts` | writes `packages/api-client/openapi.json` for SDK generation |

Handlers → services → repositories (spec §9.1): no SQL in handlers, no HTTP in services.

## Authentication

`/api/auth/*` is better-auth (sign-up/sign-in with email + password, passkey registration and sign-in,
`/sign-in/social` with `provider: "oidc"` when `PERCH_OIDC_ISSUER`, `PERCH_OIDC_CLIENT_ID`, and
`PERCH_OIDC_CLIENT_SECRET` are set). Every other `/api/*` request resolves the caller once: a
`Authorization: Bearer pat_…` api token (sha256 lookup in `api_tokens`) or the session cookie. Routes that
need a user answer `forbidden` with `details.reason = "unauthenticated"` when there is none (ADR-0044).
Tokens are shown once at creation (ADR-0045); invites are 7-day hashed links bound to the invited email
(ADR-0046). Passkeys bind to the hostname of `PERCH_PUBLIC_URL` (ADR-0048).
