# CI and releases

Spec §8. Everything runs on GitHub Actions; nothing needs a secret except the optional npm publish.

## On every pull request and push to main (`ci.yml`)

| Job | What |
|---|---|
| `check` | `bun install --frozen-lockfile`, Biome, typecheck, `bun test` on PGlite **and** a `pgvector/pgvector` service container (`PERCH_TEST_DATABASE_URL`), then the SDK drift check (`bun run sdk:generate && git diff --exit-code`) |
| `e2e` | web build, `bun run perf` (bundle and WS envelope budgets), `bun run ct` (component tests with axe), `bun run e2e` from the setup wizard with axe on every page; reports uploaded on failure |

`bun run e2e` runs every spec at a desktop and a phone viewport, and then Phase 1's exit criterion
(`e2e/phase1.e2e.ts`) four more times — `phase1-key`, `phase1-ollama`, `phase1-opencode`,
`phase1-acp` — which is one loop (clone via GitHub → ask for a change → watch it in Preview from a
phone → review the diff → commit → pull request) on a key, on Ollama, through OpenCode, and through
ACP. `scripts/e2e-server.ts` starts what each lane talks to: a stand-in GitHub per lane, an
OpenAI-shaped provider, a real Vite dev server, and a stand-in `opencode serve`; where each one
ended up is written to `E2E_MANIFEST` (ADR-0089). Run one with
`bunx playwright test --project=phase1-opencode`.
| `laptop-smoke` | Linux, macOS, Windows: `bun test apps/cli apps/runner` — `perch dev` on PGlite with the in-process runner, doctor, backup, restore, and the compiled binary serving the embedded web app; then `bun test apps/desktop` (a real window on laptop mode, under xvfb on Linux, `PERCH_DESKTOP_NATIVE=1`) and the desktop binary's `--check` |
| `docs-site` | `bun scripts/docs-site.ts` (every page, every link between them, the sidebar) and then the Astro Starlight build with its Pagefind search index; the built site is uploaded as an artifact (task 4.7) |
| `runner-agents` | builds the runner image's `agents` stage and checks that Codex, Claude Code, Gemini CLI and OpenCode each report the version `deploy/agents.json` pins, and that both ACP bridges are on PATH (task 4.6); then Trivy on that image, because the runner is the one that runs other people's code (task 4.9) |
| `compose-smoke` | builds the api and caddy images, `perch init`, `docker compose up`, the setup wizard and a sign-in through Caddy (`scripts/compose-smoke.ts`), the backup and restore drill (a backup through `/api/admin/backup`, restored into an empty Postgres database beside the live one, task 4.4), then Trivy on the image and the repository (CRITICAL and HIGH, unfixed ignored) |
| `dco.yml` | `Signed-off-by` on every commit |
| `codeql.yml` | weekly CodeQL (security-and-quality) |
| `security.yml` | daily: Trivy over every lockfile in the repository and over the published `:latest` images — the advisory published after a merge, which no per-push scan can catch (task 4.9, `docs/security.md`) |
| `changesets.yml` | manual: opens or refreshes a "Version Packages" pull request from the pending changesets (needs the "Allow GitHub Actions to create and approve pull requests" repository setting); the usual flow is `bun run version` on main and a Release run |

## On a tag `v<version>`, or a manual run with a version (`release.yml`)

Push a tag `v<version>`, or run the workflow by hand (Actions → Release → Run workflow) with the version
without the `v`: the tag is created at the chosen ref when it does not exist. Before either, run
`bun run version` and push the version bump.

1. `artifacts`: web build, SDK generation, `bun run build:cli` (binaries for linux x64/arm64, macOS arm64/x64, Windows x64 with the web app embedded; the `perch-dev` npm package), an SPDX SBOM of the source tree the binaries were built from (`sbom-perch-<version>.spdx.json`, task 4.9), `SHA256SUMS` over the binaries **and** that SBOM, a cosign keyless signature over those checksums (`SHA256SUMS.sig`, `SHA256SUMS.pem`), and the package-manager manifests `scripts/packaging.ts` generates from them (Homebrew formula, the three winget files, an AUR `PKGBUILD`, a nix `flake.nix`).
1b. `desktop`: one job per platform (ubuntu x64 and arm64, macOS arm64, Windows x64) builds `perch-desktop-<os>-<arch>` with `scripts/build-desktop.ts` (the macOS `.app` zip too), checks the native layer from the binary, and uploads checksums.
2. `images`: `perch-api`, `perch-runner`, `perch-caddy` built for `linux/amd64` and `linux/arm64`, pushed to GHCR (`ghcr.io/<owner>/perch-<image>:<version>`, plus `<major>.<minor>` and `latest` for stable versions only), signed with cosign (keyless, Sigstore), with an SPDX SBOM attested and uploaded.
3. `publish`: the GitHub release (pre-release when the tag has a suffix such as `v0.2.0-rc.1`) with the binaries, the desktop apps, checksums and their signature, the packaging manifests, `openapi.json`, the docs site (`docs-site-<version>.tar.gz`), and SBOMs; `npm publish perch-dev` when `NPM_TOKEN` is set (`--tag next` for pre-releases).

Verify an image: `cosign verify ghcr.io/12burb/perch-api:<version> --certificate-identity-regexp 'github.com/12burb/perch' --certificate-oidc-issuer https://token.actions.githubusercontent.com`.

Verify a binary: the installers and `perch upgrade` do it for you; by hand it is `cosign verify-blob`
over `SHA256SUMS` with the same identity ([`install.md`](install.md)).

## Budgets (`scripts/perf-budget.ts`)

| Budget | Value |
|---|---|
| initial JS + CSS (gzip) | 180 KB |
| app JS (gzip): the entry, its imports, and every route chunk the app splits off | 700 KB |
| on-demand packs JS (gzip): chunks a library loads lazily on its own (CodeMirror's ~40 grammars), one per file type opened | 480 KB |
| CSS (gzip) | 48 KB |
| one WS envelope (presence, typing, message.created, session.delta samples) | 1 KB |
| i18n fragments outside the entry chunk | 0 leaked |
| long lists that are neither virtualized nor capped | 0 |

The split comes from Vite's manifest (`apps/web/dist/.vite/manifest.json`, ADR-0072): static imports
always belong to the app; a dynamic import counts as the app's when its target is app code (a route
under `src/`) and as a pack when the target lives in `node_modules`. `bun run perf` prints the total
too, as information.

### Long lists

Ground rule 7 says every long list is virtualized. There is no number to measure for that, so the
audit keeps a register instead: `LIST_SURFACES` in `scripts/perf-budget.ts` names every list Perch
renders from server data and how it is kept short.

- **virtualized** — the file must render through `VirtualList` or its own `useVirtualizer`.
- **capped** — a named file must still contain the cap (`limit: 100`, `SIDEBAR_ROWS = 30`, …). Take
  the cap out and the audit says which one went.
- **bounded** — a reasoned exemption, in the register where a reviewer can see it: the editor's
  tabs, the drawer's tabs, a preview's ports. These grow with what one person did, not with the
  workspace.

A `.tsx` under `apps/web/src` or `packages/ui/src` that has its own scroll container and a `.map(`
and is *not* in the register fails the audit. That is the part that matters: a new screen with a
long list cannot get past CI without somebody writing down how it stays fast.

## Pins

Actions are pinned to major tags today; Renovate (`helpers:pinGitHubActionDigests`) pins them to digests
in its first run. Images and toolchains are pinned in `docs/dependencies.md`.
