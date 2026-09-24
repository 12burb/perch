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
| `src/auth/` | better-auth (`createAuth`: email + password, passkeys, generic OIDC), the `authenticate` / `requireUser` middleware, and `authorize()` (membership + `@perch/policy` decision → not_found / forbidden) |
| `src/audit/` | the bus subscriber that writes `audit_log` rows for every workspace event (spec §7.7) |
| `src/ws/` | `/api/ws` (spec §7.2): topic authorization, presence registry, subscribe/resume/typing over the bus |
| `src/routes/` | one file per resource, each a `createRoute` + handler pair (`/api/me`, `/api/me/tokens`, `/api/workspaces` with members, invites, audit, `/api/invites`, `/api/instance`) |
| `src/services/` | pure functions over `Db` and `Bus` (profiles, api tokens, workspaces, invites) |
| `src/repos/` | Drizzle queries, workspace-scoped |
| `scripts/export-openapi.ts` | writes `packages/api-client/openapi.json` for SDK generation |

Handlers → services → repositories (spec §9.1): no SQL in handlers, no HTTP in services.

## Restarts and shutdown

Only the `api` entrypoint (and laptop mode) owns the work a restart interrupts, so only it boots
with `recover` on (ADR-0165, ADR-0177): project setups left `pending`/`setting_up` are failed,
coding sessions left `running`/`needs_you` and bot runs left `running` are ended as errors with
"interrupted by a restart" (and `session.status` / `bot.run_failed` go out, so the board, races and
cards follow), and the merge queue is started — it resumes every project with waiting work a tick
after boot and every minute after. `supervisor`, `worker`, `backup` and `restore` boot with it off.
On `SIGTERM`, `shutdown()` in `src/boot.ts` stops the HTTP server first, then the jobs worker (or the
supervisor), then `close()`.

## Authentication

`/api/auth/*` is better-auth (sign-up/sign-in with email + password, passkey registration and sign-in,
`/sign-in/social` with `provider: "oidc"` when `PERCH_OIDC_ISSUER`, `PERCH_OIDC_CLIENT_ID`, and
`PERCH_OIDC_CLIENT_SECRET` are set). Every other `/api/*` request resolves the caller once: a
`Authorization: Bearer pat_…` api token (sha256 lookup in `api_tokens`) or the session cookie. Routes that
need a user answer `forbidden` with `details.reason = "unauthenticated"` when there is none (ADR-0044).
Tokens are shown once at creation (ADR-0045); invites are 7-day hashed links bound to the invited email
(ADR-0046). Passkeys bind to the hostname of `PERCH_PUBLIC_URL` (ADR-0048).

## Authorization and audit

Every workspace-scoped handler calls `authorize(c, deps, action, resource)` first (spec §9.1). It loads
the caller's membership, applies the `@perch/policy` role matrix and token scopes (ADR-0051), answers
`not_found` for non-members and `forbidden` (with `details.reason` and `details.action`) for everything
else, and stamps `workspace_id` on the request log. Handlers publish with `actorOf(c)` so every bus event
carries the actor, request id, and client ip; the audit subscriber turns each workspace event into an
`audit_log` row and `GET /api/workspaces/{ws}/audit` reads them (ADR-0052, ADR-0053).
