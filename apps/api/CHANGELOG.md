# @perch/api

## 0.1.1

### Patch Changes

- ea81bde: The runner control channel (spec §7.6): runners connect to `/api/runner` with a connect token, register,
  heartbeat, and answer api requests that carry per-request capability tokens; the runner image now runs
  the runner agent as its entrypoint (`PERCH_API_URL`, `PERCH_RUNNER_TOKEN`).
- Updated dependencies [ea81bde]
  - @perch/events@0.0.2
  - @perch/bus@0.0.2

## 0.1.0

### Minor Changes

- The first downloadable release: `perch` binaries for Linux (x64, arm64), macOS (arm64, x64), and Windows
  (x64) with the web app embedded, and the `perch-desktop` app for Linux, macOS, and Windows, all built and
  attached to the GitHub release by the release workflow.

### Patch Changes

- 5f7bace: The api image ships a production-only runtime tree: the api workspace, the packages it links, and the
  web build, with no dev tools, spike dependencies, or native build binaries, on a base image with Debian
  security updates applied. Spike packages declare their libraries as devDependencies.
- 803f280: The api image builds again: the `connectors` and `templates` workspaces are copied into the build stage
  (a frozen `bun install` needs every workspace in the lockfile), and a `.dockerignore` keeps installs,
  builds, and `.env` files out of the build context.
- 9d8ca25: apps/api skeleton: Hono + zod-openapi with the OpenAPI document at /api/openapi.json, the §7.8 error model with request ids, pino request logging with secret redaction, Perch-Version handling, GET /api/health and /api/version, boot wiring (env → db migrations → bus, vault, queue), and the generated TypeScript client (@perch/api-client) typed end to end.
- ed5ab78: Authentication (task 0.8): better-auth on the Drizzle adapter with email + password, passkeys
  (`@better-auth/passkey`, bound to `PERCH_PUBLIC_URL`), and generic OIDC through `PERCH_OIDC_*`; a Perch
  `users` profile row for every auth user; `GET/PATCH /api/me`; api tokens (`/api/me/tokens`, shown once,
  stored hashed, accepted as `Bearer pat_…`); workspaces with owner memberships; email invites
  (`POST /api/workspaces/{ws}/invites`, public preview, accept bound to the invited email); a public
  `GET /api/instance`; the first web routes (sign in, sign up, invite, security settings) with `t()` strings
  and design tokens from `@perch/ui`; Playwright e2e (`bun run e2e`) covering sign up, passkey sign-in, api
  tokens, and invite acceptance at 1440 px and 390 px.
- b7d9c3a: CI and releases (task 0.15): the pull-request pipeline (Biome, typecheck, unit tests on PGlite and
  Postgres, SDK drift, perf budgets, component tests with axe, Playwright from the setup wizard, the
  laptop smoke on Linux/macOS/Windows, the compose smoke with Trivy), weekly CodeQL, the changesets
  version pull request, and the tag release: multi-arch images on GHCR signed with cosign with attested
  SBOMs, perch binaries per platform with the web app embedded, and the `perch-dev` npm package.
- ae3e4ab: Deploy (task 0.13): `deploy/Dockerfile.api` (Bun runtime, Vite build under Node, non-root, `api | worker |
  supervisor`), `deploy/Dockerfile.runner` (the Ubuntu 24.04 runner base), `deploy/Dockerfile.caddy`
  (Caddy with a DNS-challenge module), the pinned `docker-compose.yml` with the `local` and `tunnel`
  profiles, the Caddyfiles, `.env.example`, `perch init` (writes `.env` with generated secrets, the compose
  file, and the Caddyfile), and the setup wizard: `POST /api/setup` creates the admin, the first workspace,
  confirms `PERCH_PUBLIC_URL`, records the telemetry choice, and sign-ups stay closed until it has run.
- b55c1a4: Governance files: README with the 60-second install, CONTRIBUTING (DCO, no CLA), CODE_OF_CONDUCT (Contributor Covenant 2.1), SECURITY (GitHub Security Advisories, 3-day ack, 90-day disclosure), GOVERNANCE, PLEDGE, docs/telemetry.md, docs/policies/providers.md, the RFC template, and a DCO check enforced in CI.
- 833ab7d: The jobs worker no longer crashes at boot in team mode: the claim query binds its timestamps through the
  column encoders instead of interpolating Dates into a raw sql template, which postgres.js could not
  serialize under drizzle's transparent timestamp serializers. The queue suite now runs on Postgres as
  well as PGlite in CI.
- 45c4eee: Laptop mode (task 0.14): `perch dev` runs the api, the web app, and an in-process runner on PGlite under
  `~/.perch`; `perch doctor` checks the machine and the data directory; `perch backup` and `perch restore`
  round-trip the PGlite data, files, and master key as a backup directory. `RunnerLink` in `@perch/events`
  and the api's runner registry (`GET /api/health` now reports `checks.runners` and `mode`) are the seam
  the hosted and local runners plug into next.
- e05fb7a: Resolve and pin every dependency named in the spec (docs/dependencies.md), with ADR-0019..0028 for the non-obvious picks; commit the lockfile.
- 3ab9ae7: Scaffold the monorepo: Bun workspaces, Turborepo, Biome, strict TypeScript, Changesets, Renovate, PR and issue templates, the AGPL-3.0 / MIT license split, and repository invariant tests.
- 62de53e: Workspaces, memberships, RBAC, and the audit log (task 0.9): `authorize(ctx, action, resource)` in
  `@perch/policy` (role matrix + token scopes) applied in every workspace handler, with non-members getting
  `not_found`; `GET/PATCH /api/workspaces/{ws}`, `GET /api/workspaces/{ws}/members`,
  `PATCH/DELETE /api/workspaces/{ws}/members/{user}` (owner rules, last-owner protection, leave);
  the `audit_log` table (migration 0003) written by a bus subscriber for every workspace event, with
  `GET /api/workspaces/{ws}/audit`; bus envelopes now carry `meta` (request id, client ip).
- 1d93dfb: WebSocket server at `/api/ws` (task 0.10, spec §7.2): subscribe/unsubscribe with per-topic
  authorization, `resume { topic, after_seq }` from the replay buffer (or `resync` when it fell off),
  presence per user per workspace with a `presence_snapshot` on subscribe, rate-limited typing on channel
  topics, and the web client (`PerchSocket`, `usePresence`) showing who is online per workspace.
- Updated dependencies [027121b]
- Updated dependencies [85b6bb8]
- Updated dependencies [833ab7d]
- Updated dependencies [45c4eee]
- Updated dependencies [eaa6104]
- Updated dependencies [e05fb7a]
- Updated dependencies [62de53e]
- Updated dependencies [1d93dfb]
  - @perch/events@0.0.1
  - @perch/bus@0.0.1
  - @perch/jobs@0.0.1
  - @perch/vault@0.0.1
  - @perch/db@0.0.1
  - @perch/policy@0.0.1
