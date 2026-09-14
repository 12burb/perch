# CI and releases

Spec §8. Everything runs on GitHub Actions; nothing needs a secret except the optional npm publish.

## On every pull request and push to main (`ci.yml`)

| Job | What |
|---|---|
| `check` | `bun install --frozen-lockfile`, Biome, typecheck, `bun test` on PGlite **and** a `pgvector/pgvector` service container (`PERCH_TEST_DATABASE_URL`), then the SDK drift check (`bun run sdk:generate && git diff --exit-code`) |
| `e2e` | web build, `bun run perf` (bundle and WS envelope budgets), `bun run ct` (component tests with axe), `bun run e2e` from the setup wizard with axe on every page; reports uploaded on failure |
| `laptop-smoke` | Linux, macOS, Windows: `bun test apps/cli apps/runner` — `perch dev` on PGlite with the in-process runner, doctor, backup, restore, and the compiled binary serving the embedded web app; then `bun test apps/desktop` (a real window on laptop mode, under xvfb on Linux, `PERCH_DESKTOP_NATIVE=1`) and the desktop binary's `--check` |
| `compose-smoke` | builds the api and caddy images, `perch init`, `docker compose up`, the setup wizard and a sign-in through Caddy (`scripts/compose-smoke.ts`), then Trivy on the image and the repository (CRITICAL and HIGH, unfixed ignored) |
| `dco.yml` | `Signed-off-by` on every commit |
| `codeql.yml` | weekly CodeQL (security-and-quality) |
| `changesets.yml` | manual: opens or refreshes a "Version Packages" pull request from the pending changesets (needs the "Allow GitHub Actions to create and approve pull requests" repository setting); the usual flow is `bun run version` on main and a Release run |

## On a tag `v<version>`, or a manual run with a version (`release.yml`)

Push a tag `v<version>`, or run the workflow by hand (Actions → Release → Run workflow) with the version
without the `v`: the tag is created at the chosen ref when it does not exist. Before either, run
`bun run version` and push the version bump.

1. `artifacts`: web build, SDK generation, `bun run build:cli` (binaries for linux x64/arm64, macOS arm64/x64, Windows x64 with the web app embedded; the `perch-dev` npm package), SHA256SUMS.
1b. `desktop`: one job per platform (ubuntu x64 and arm64, macOS arm64, Windows x64) builds `perch-desktop-<os>-<arch>` with `scripts/build-desktop.ts` (the macOS `.app` zip too), checks the native layer from the binary, and uploads checksums.
2. `images`: `perch-api`, `perch-runner`, `perch-caddy` built for `linux/amd64` and `linux/arm64`, pushed to GHCR (`ghcr.io/<owner>/perch-<image>:<version>`, plus `<major>.<minor>` and `latest` for stable versions only), signed with cosign (keyless, Sigstore), with an SPDX SBOM attested and uploaded.
3. `publish`: the GitHub release (pre-release when the tag has a suffix such as `v0.2.0-rc.1`) with the binaries, the desktop apps, checksums, `openapi.json`, and SBOMs; `npm publish perch-dev` when `NPM_TOKEN` is set (`--tag next` for pre-releases).

Verify an image: `cosign verify ghcr.io/12burb/perch-api:<version> --certificate-identity-regexp 'github.com/12burb/perch' --certificate-oidc-issuer https://token.actions.githubusercontent.com`.

## Budgets (`scripts/perf-budget.ts`)

| Budget | Value |
|---|---|
| initial JS + CSS (gzip) | 180 KB |
| app JS (gzip): the entry, its imports, and every route chunk the app splits off | 420 KB |
| on-demand packs JS (gzip): chunks a library loads lazily on its own (CodeMirror's ~40 grammars), one per file type opened | 480 KB |
| CSS (gzip) | 48 KB |
| one WS envelope (presence, typing, message.created, session.delta samples) | 1 KB |

The split comes from Vite's manifest (`apps/web/dist/.vite/manifest.json`, ADR-0072): static imports
always belong to the app; a dynamic import counts as the app's when its target is app code (a route
under `src/`) and as a pack when the target lives in `node_modules`. `bun run perf` prints the total
too, as information.

The full perf audit (list virtualization, per-frame batching) is task 2.20.

## Pins

Actions are pinned to major tags today; Renovate (`helpers:pinGitHubActionDigests`) pins them to digests
in its first run. Images and toolchains are pinned in `docs/dependencies.md`.
