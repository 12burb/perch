# Phase 0 report

Every Phase 0 task (spec §11, 0.1–0.15) is `[x]` in [`../TASKS.md`](../TASKS.md). Delivered on the single
branch `claude/admiring-hamilton-lj14ir` as one DCO-signed conventional commit per task (ADR-0018); the
repository had no default branch when work started, so there are no per-task pull requests.

## Commits

| Task | Commit |
|---|---|
| spec | `docs(spec): persist the Perch specification and operating manual` |
| 0.1 | `feat(scaffold): bun workspaces, turborepo, biome, strict ts, changesets, renovate` |
| 0.2 | `docs(governance): readme, contributing, conduct, security, governance, pledge, dco check` |
| 0.3 | `chore(deps): resolve and pin the §2 stack` |
| 0.4 | `feat(spikes): phase 0 spikes with recorded outcomes` |
| 0.5 | `feat(db): drizzle schema, db factory, embedded migrations, pglite harness` |
| 0.6 | `feat(core): events catalog, in-process bus, postgres job queue, vault` |
| 0.7 | `feat(api): hono skeleton with openapi, error model, request logging, typed client` |
| 0.8 | `feat(auth): better-auth with passkeys and OIDC, profiles, invites, api tokens` |
| 0.9 | `feat(workspaces): rbac with authorize(), members, and the audit log via the bus` |
| 0.10 | `feat(ws): /api/ws with subscribe, resume, presence, and typing` |
| 0.11 | `feat(ui): tokens, themes, shadcn base, and the shell components with component tests` |
| 0.12 | `feat(web): the shell with six modes, mobile tab bar, empty states, and settings` |
| 0.13 | `feat(deploy): dockerfiles, compose, caddy, perch init, and the setup wizard` |
| 0.14 | `feat(cli): perch dev on PGlite with the in-process runner, doctor, backup, and restore` |
| 0.15 | `ci: the §8 pipeline, weekly CodeQL, changesets, and the signed multi-arch release` |

## Verification (last run, this environment)

| Check | Result |
|---|---|
| `bun run check` (Biome, TypeScript 7, `bun test`) | 130 pass, 7 skip (Docker/credential-gated spikes), 0 fail across 30 files |
| `bun run e2e` from the setup wizard (`E2E_SETUP=wizard`) | 12 passed: wizard, sign up, passkey sign-in, api tokens, invite accepted, presence between two tabs, the six modes and settings with axe, at 1440 px and 390 px |
| `bun run ct` (packages/ui component tests with axe) | 27 passed, 1 skipped (desktop-only keyboard test on the mobile project) |
| `bun run perf` | initial 172 KB gzip (budget 180), total JS 188 KB (budget 320), WS envelopes ≤ 684 B (budget 1 KB) |
| laptop smoke (`bun test apps/cli`) | `perch dev` on PGlite with the in-process runner, doctor, backup, restore, and the compiled binary serving the embedded web app |

Screenshots for 0.12 are in [`screenshots/0.12/`](screenshots/0.12/) (desktop 1440 px, mobile 390 px).

## Spike outcomes (spec §9.3, ADR-0029..0038)

| Spike | Outcome |
|---|---|
| 0.4.1 PTY on Bun | fallback: node-pty fails on Bun (`resize` EBADF); **bun-pty** is the PTY (ADR-0029) |
| 0.4.2 ACP handshake | pass: the official SDK initializes and streams on Bun; real agents gated on credentials in CI (ADR-0030) |
| 0.4.3 OpenCode SDK | pass: serve, sessions, events, diff; a streamed reply needs a provider key (ADR-0031) |
| 0.4.4 PGlite | pass: schema, pgvector (separate package), citext, SKIP LOCKED in memory (ADR-0032) |
| 0.4.5 QuickJS sandbox | pass on the sync build with promise-based host tools and a memory limit (ADR-0033) |
| 0.4.6 better-auth on Bun | pass at the HTTP level; browser passkeys proven in 0.8 with the virtual authenticator (ADR-0034) |
| 0.4.7 dockerode from Bun | pass in CI (ubuntu runner): pull, create with limits, start, exec, stop, remove; a hijacked exec is not usable from Bun, one-shot execs are (ADR-0035) |
| 0.4.8 Caddy wildcard | deferred (needs a DNS token); path-mode previews are the default (ADR-0036) |
| 0.4.9 Preview tunnel | pass: Vite HMR end to end over an outbound runner socket (ADR-0037) |
| 0.4.10 cloudflared | deferred (needs a tunnel token); Tailscale Serve/Funnel documented (ADR-0038) |

## ADRs added (ADR-0018..0060)

ADR-0001..0017 are the spec's locked decisions. Added during Phase 0:

- 0018 single-branch delivery (spec deviation) · 0019 TypeScript 7 · 0020 Playwright 1.62.1 · 0021 ACP SDK
  package · 0022 SDK via openapi-typescript/openapi-fetch · 0023 unified `radix-ui` · 0024 drizzle-kit 0.31 ·
  0025 UUID v7 from Bun · 0026 oauth2-mock-server · 0027 in-house `t()` · 0028 npm name `perch-dev`
- 0029..0038 spike outcomes (table above)
- 0039 embedded migrations under an advisory lock · 0040 `messages.text_search` via jsonpath · 0041 `jobs.key`
  · 0042 TypeScript 5.9 inside api-client · 0043 Perch-Version enforced
- 0044 unauthenticated = 403 with `reason` · 0045 `pat_` tokens hashed, shown once · 0046 invites · 0047
  profile rows and numeric suffixes · 0048 passkeys bind to the public origin · 0049 `GET /api/instance` ·
  0050 committed `routeTree.gen.ts` and `e2e/*.e2e.ts`
- 0051 RBAC v0 matrix + token scopes · 0052 audit log as a bus subscriber · 0053 bus `meta` · 0054 `/api/ws`
  semantics · 0055 UI system and `*.ct.tsx` · 0056 web shell URLs and committed screenshots · 0057 the setup
  wizard · 0058 deploy layout and image pins · 0059 laptop mode (RunnerLink, backups, doctor) · 0060 the
  pipeline, budgets, embedded assets, release semantics
- 0061 timestamp parameters through column encoders · 0062 production-only api image on an updated base

## Spec deviations and open points

1. **Single branch, no per-task PRs** (ADR-0018): the harness fixes the branch and the repository had no
   default branch; task evidence lives in commit messages, `TASKS.md`, and this report instead of PR
   descriptions. `main` now exists (at the spec commit) and the whole phase is
   [PR #1](https://github.com/12burb/perch/pull/1).
2. **Unauthenticated → `forbidden` (403)**: spec §7.8 has no 401; `details.reason = "unauthenticated"`
   (ADR-0044).
3. **Additive endpoints**: `GET /api/instance`, `POST /api/setup`, `GET /api/workspaces/{ws}/audit`
   (the spec lists `/api/admin/audit`, instance-wide, which comes with admin settings) (ADR-0049, 0052, 0057).
4. **`routeTree.gen.ts` is committed** rather than git-ignored (ADR-0050).
5. **Docker-dependent verification ran in CI** (this environment has no Docker daemon): run
   [34797151379](https://github.com/12burb/perch/actions/runs/34797151379) is green across the matrix.
   The compose smoke (task 0.13's fresh-VM criterion) builds the api and caddy images, runs `perch init`,
   brings the stack up, completes the setup wizard and sign-in, and passes Trivy on the image and the
   repository. The laptop smoke (0.14) passes on ubuntu-latest, macos-latest, and windows-latest,
   including the compiled binary with the embedded web app and PGlite. The dockerode spike passes on the
   ubuntu runner (ADR-0035). The first runs found defects that this branch fixes: the image build omitted
   two workspaces and ran node-pty's install script, the jobs worker crashed on postgres.js (ADR-0061), a
   hijacked docker exec fails under Bun (ADR-0035), and the image carried dev-tool binaries and stale
   Debian packages (ADR-0062).
6. **Playwright's Chromium** could not be downloaded here; the suites ran on the preinstalled build via
   `PLAYWRIGHT_CHROMIUM_EXECUTABLE` (ADR-0050). CI installs the matching browser.
7. **Deferred spikes** (Caddy wildcard, cloudflared) need a DNS token and a tunnel token
   (`spikes.yml`, workflow_dispatch); path-mode previews and Tailscale are the documented defaults.
8. **`@perch/inspector` license**: the spec puts the inspector plugin in the AGPL set while it is meant to
   run inside users' dev servers; a follow-up decision is flagged in `docs/dependencies.md`.
9. **Telemetry ping**: the wizard records the choice; the sending code arrives with the endpoint
   (docs/telemetry.md).
10. **Release verification**: the tag workflow is written and its pieces are tested (binaries compile and
    run, the npm package stages, images build in the compose smoke), but "a tagged pre-release publishes
    signed images" can only be exercised by pushing a `v*` tag.

## Next

Phase 1 (spec §11, 1.1–1.21) starts from `TASKS.md`: the runner agent on the RunnerLink seam, the
supervisor on the dockerode outcome, the local runner, projects, and the editor.
