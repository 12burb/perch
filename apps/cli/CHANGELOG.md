# @perch/cli

## 0.3.0

### Minor Changes

- f519b64: Backups you can trust. A Perch now takes one on a schedule — `PERCH_BACKUP_DIR` turns it on,
  `PERCH_BACKUP_CRON` says when, `PERCH_BACKUP_KEEP` says how many to keep — and `/api/admin/backup`
  takes one now and lists what is there. A backup is a directory: the database as a gzipped
  JSON-lines dump, the files beside it, the project volumes added by the supervisor, and a manifest.
  
  The dump is Perch's own format rather than `pg_dump` or PGlite's data directory, so **a laptop
  backup restores into a team instance on Postgres, and back**. Restoring is "migrate, then load",
  which also means a backup restores into a later Perch:
  
  ```sh
  docker compose exec api bun apps/api/src/index.ts backup
  docker compose exec -e DATABASE_URL=…/perch_restore api bun apps/api/src/index.ts restore /data/backups/<id>
  perch backup ./today && perch restore ./today --portable
  ```
  
  The vault key is **not** in a backup unless you ask (`PERCH_BACKUP_INCLUDE_KEY=on`): its
  fingerprint is, so a restore says plainly whether the key you have is the key those rows were
  encrypted with. Restoring into an instance that already has rows is refused rather than merged.
  
  CI restores a backup on every push, in both modes — laptop on Linux, macOS and Windows, and team
  into an empty Postgres database beside the live one.
- 8362875: Connectors are files. Point `PERCH_CONNECTORS_DIR` at a directory of `<id>/manifest.yaml` and those
  providers appear in Connections at the next boot, with the paste lane, the sign-in lane, the test
  call, the MCP server and the webhook scheme all read off the file — a connector can now be added,
  or a broken built-in one corrected, without a fork and without waiting for a release.
  
  Six more ship in the box: Slack, Stripe, Linear, Notion, Sentry and Discord, alongside GitHub,
  Vercel, Supabase and Clerk. Making them work meant the manifest could say more: `token_scheme: raw`
  for a provider that wants the token without `Bearer` in front of it, `headers:` for one that needs
  its own on every call, and `webhook.timestamp_prefix` for Stripe's `t=<ts>,v1=<hex>`, where the
  signed timestamp rides inside the signature header. `webhook.id_header` and `event_header` are now
  optional, because a provider that puts neither in a header — Slack, Stripe — is normal.
  
  `perch connectors check <dir>` is the harness. It parses a manifest and then exercises what it
  claims: a delivery signed by its own scheme must verify, the same delivery with a byte changed must
  not, and somebody else's secret must not. It says when a lane does not add up, and it says out loud
  when a provider signs nothing at all, which three of them really do. Every connector in this repo
  goes through it in CI.
  
  OAuth tokens now refresh. A connection whose access token expires within the next minute is swapped
  before the call that needed it goes out, on the same app it was made with; one nobody is using is
  left alone. A refresh the provider refuses marks the connection Not accepted rather than failing a
  moment later with something less useful.
- 1d5af02: Install anywhere, and upgrade in place. `curl -fsSL .../install.sh | sh` on macOS and Linux, `irm
  .../install.ps1 | iex` on Windows: one binary, on your PATH, in a few seconds. `perch upgrade`
  replaces the binary that is running it with the newest release — `--check` to look first, `--force`
  to reinstall the version already there.
  
  Nothing is installed that the release did not vouch for. The download must match the release's own
  `SHA256SUMS`, and those checksums are now signed by the release workflow with cosign (keyless,
  Sigstore): the signature is verified when cosign is on the machine, and
  `PERCH_REQUIRE_SIGNATURE=1` (or `perch upgrade --require-signature`) refuses an install that cannot
  be checked that far. A tampered binary installs nothing at all and leaves the Perch you had.
  
  Every release also publishes the package-manager manifests, generated from that release's own
  checksums so they cannot drift from what was built: a Homebrew formula, the three winget files, an
  AUR `PKGBUILD` and a nix `flake.nix`. `docs/install.md` has the lot, including how to check a
  download by hand.
- 7ccdff3: Starter stacks, one-click projects, and a Perch that starts with something in it.
  
  `templates/` now holds four starter stacks — a Bun API, a Next.js app, a FastAPI service and a
  static site — served at `GET /api/templates` and pickable from Code mode's New project form.
  Choosing one makes a project that arrives with the stack's files and its own `.perch/project.json`
  already read, so Perch knows the run commands and the preview's port before you touch anything.
  
  The Preview tab can now start it: **Start** runs the project's own `preview.command` on its runner,
  waits for the port, and shows the tail of the dev server's output if it does not come up. **Stop**
  takes it down, along with everything it started.
  
  A fresh instance no longer opens on a set of empty states: `PERCH_DEMO_WORKSPACE` (on by default)
  seeds the first workspace with three channels, two bots and a project from a starter stack just
  after the setup wizard, and `perch demo` does the whole thing in one command on a laptop.

### Patch Changes

- 03efd44: Security scanning: the runner image's findings are tracked, not silenced.
  
  The new scan of the runner image found four HIGH advisories, all inside the agent CLIs that image
  pins — `brace-expansion`, `ip-address` and `tar`, none of them something Perch depends on, and all
  four CLIs already at their newest published version. `.trivyignore.yaml` accepts them one at a
  time, each scoped to the tree it was found in, each with a reason, and each with a date it comes
  back. `docs/security.md` carries the same list in prose, and the disclosure drill fails if an entry
  loses its reason or its date passes.
- e0fa6ce: The demo workspace no longer starts a dev server behind the setup wizard.
  
  Seeding a project is one thing; leaving a process listening on a port nobody asked about, as part of
  finishing a wizard, is another — and on Windows it outlived the instance that started it. The seed
  now creates the project and stops there, and the welcome message says which button starts it.
  `perch demo`, where somebody did ask to see a preview running, still starts one.
  
  The runner also closes its own copy of the dev server's log handle after handing it to the child: it
  had no use for it, and on Windows it was enough to make the project's directory undeletable.
- 818fb81: Security: a scan that runs when nobody has pushed, an SBOM for the binaries, and a disclosure drill
  that is a test.
  
  A daily `security.yml` runs Trivy over every lockfile in the repository and over the published
  images — the advisory published a week after a dependency was merged is the one a per-push scan
  cannot catch. CI now scans the runner image as well as the api image, in the job that already
  builds it.
  
  Each release carries `sbom-perch-<version>.spdx.json`, an SPDX bill of materials for the source the
  binaries were built from. It is listed in `SHA256SUMS`, so the existing cosign signature covers it:
  a tampered SBOM fails the same check a tampered binary does.
  
  `docs/security.md` is the disclosure drill, and `bun run drill` walks it: the private reporting
  path, the clock, the scans, the signature, the SBOMs and the tamper tests are all asserted on every
  `bun run check`, so none of them can quietly disappear.
- Updated dependencies [82cb101]
- Updated dependencies [ab5b891]
- Updated dependencies [4c5251d]
- Updated dependencies [5f1a486]
- Updated dependencies [b579c03]
- Updated dependencies [f519b64]
- Updated dependencies [0939d63]
- Updated dependencies [1235207]
- Updated dependencies [31b4dba]
- Updated dependencies [8362875]
- Updated dependencies [e0fa6ce]
- Updated dependencies [df6e9aa]
- Updated dependencies [d2ea19a]
- Updated dependencies [57eb0aa]
- Updated dependencies [6c38559]
- Updated dependencies [602fa1f]
- Updated dependencies [5b807c8]
- Updated dependencies [fe0a09f]
- Updated dependencies [c3fe0bd]
- Updated dependencies [abed13a]
- Updated dependencies [1762cca]
- Updated dependencies [5549cfd]
- Updated dependencies [10caeec]
- Updated dependencies [a5fe8a8]
- Updated dependencies [7ccdff3]
- Updated dependencies [714f396]
- Updated dependencies [4c77c5f]
- Updated dependencies [cf4673b]
- Updated dependencies [3ae0e07]
- Updated dependencies [0f0e198]
- Updated dependencies [e367481]
- Updated dependencies [3ba2508]
- Updated dependencies [00f1986]
- Updated dependencies [925ac47]
- Updated dependencies [c2a9d67]
- Updated dependencies [fe75ba9]
- Updated dependencies [3fdf6c1]
- Updated dependencies [53b90b0]
- Updated dependencies [4c68089]
- Updated dependencies [3256729]
- Updated dependencies [50d8ab9]
- Updated dependencies [fd812c8]
- Updated dependencies [6b96260]
  - @perch/api@0.3.0
  - @perch/db@0.2.0
  - @perch/runner@0.2.0
  - @perch/connect@0.2.0

## 0.2.0

### Minor Changes

- de84546: Local runners: the Environments page lists a workspace's runners with live status, "Connect a machine"
  mints a connect token shown once inside the `perch runner connect` command, owners and admins remove
  runners, and `perch runner connect <url> --token …` joins a machine as one of your environments.
- fe9fbdd: Watch a project run. Every port a project's runner is serving now appears in Code mode's Previews
  sidebar and opens in a Preview tab beside the editor (⌘⇧P): an address bar, back and forward,
  reload, viewport presets with rotate, and a link out to a real tab. HMR passes straight through, so
  a Vite app hot-reloads inside the tab with no configuration when the instance has a preview domain.
  Share mints an expiring, revocable link that opens the preview for someone with no Perch account,
  and shows the dev server's own page — never an injected inspector.

### Patch Changes

- 2285bef: Laptop mode is held to the same standard as the server. A new test drives a real `perch dev` through
  everything Phase 1 built — projects, files, git and a written commit message, a session with a
  permission and its diff, ⌘K, a brain, a connection, the MCP gateway, a preview with a share link,
  and a terminal — on Linux, macOS, and Windows, so a feature cannot quietly work only with Docker.
- f3aefb9: Projects: create one empty, upload files into one, or clone a repository (public, with an access
  token, or with the workspace's SSH deploy key) from Code mode or the API; the directory is set up on
  a runner, `.perch/project.json` is validated and applied, `devcontainer.json` is read and its
  `postCreateCommand` runs, and the row's status updates live.
- 0d33a89: Runners answer the fs (list, read, write, stat, ripgrep-backed search), git (status, diff, commit,
  push, branch, worktrees), ports, and exec methods, every call through a policy hook with built-in
  rules (destructive commands, publishes, force pushes, git internals, exec confined to the projects
  root); the Environments list shows each runner's listening ports and the api answers them live.
- Updated dependencies [378589c]
- Updated dependencies [9246f90]
- Updated dependencies [ea3b91b]
- Updated dependencies [ed9f649]
- Updated dependencies [347ce60]
- Updated dependencies [d11b588]
- Updated dependencies [d711cbc]
- Updated dependencies [1647095]
- Updated dependencies [3af96e8]
- Updated dependencies [9c29082]
- Updated dependencies [d02fde9]
- Updated dependencies [d6528a4]
- Updated dependencies [3318f0e]
- Updated dependencies [b144df4]
- Updated dependencies [df9ec50]
- Updated dependencies [7ffcb04]
- Updated dependencies [fa24434]
- Updated dependencies [2918dc6]
- Updated dependencies [e5c8bd7]
- Updated dependencies [a837eea]
- Updated dependencies [a451282]
- Updated dependencies [3417ea3]
- Updated dependencies [de84546]
- Updated dependencies [fb30b24]
- Updated dependencies [7fd4a59]
- Updated dependencies [f39b87d]
- Updated dependencies [76ae435]
- Updated dependencies [e940d4f]
- Updated dependencies [0985050]
- Updated dependencies [fe9fbdd]
- Updated dependencies [5f61320]
- Updated dependencies [c4e921c]
- Updated dependencies [f3aefb9]
- Updated dependencies [eb5cdaa]
- Updated dependencies [52af50e]
- Updated dependencies [8d7d282]
- Updated dependencies [ea81bde]
- Updated dependencies [0d33a89]
- Updated dependencies [9b25388]
- Updated dependencies [bb1f0e5]
- Updated dependencies [3764521]
- Updated dependencies [cc5c90d]
- Updated dependencies [365bdc5]
- Updated dependencies [a438fc6]
- Updated dependencies [f0ff645]
- Updated dependencies [6cc4171]
  - @perch/runner@0.1.0
  - @perch/api@0.2.0
  - @perch/db@0.1.0

## 0.1.0

### Minor Changes

- The first downloadable release: `perch` binaries for Linux (x64, arm64), macOS (arm64, x64), and Windows
  (x64) with the web app embedded, and the `perch-desktop` app for Linux, macOS, and Windows, all built and
  attached to the GitHub release by the release workflow.

### Patch Changes

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
- bb09a5c: The Perch desktop app: `perch-desktop` runs laptop mode (api, web, and the in-process runner on PGlite
  under `~/.perch`) in a native window on macOS, Windows, and Linux, on a fixed localhost port so sign-ins
  survive restarts, attaches to a Perch already running there, and opens a team instance with `--url`.
  `perch dev` now shares its boot with the app (`@perch/cli/laptop`).
- 45c4eee: Laptop mode (task 0.14): `perch dev` runs the api, the web app, and an in-process runner on PGlite under
  `~/.perch`; `perch doctor` checks the machine and the data directory; `perch backup` and `perch restore`
  round-trip the PGlite data, files, and master key as a backup directory. `RunnerLink` in `@perch/events`
  and the api's runner registry (`GET /api/health` now reports `checks.runners` and `mode`) are the seam
  the hosted and local runners plug into next.
- 3ab9ae7: Scaffold the monorepo: Bun workspaces, Turborepo, Biome, strict TypeScript, Changesets, Renovate, PR and issue templates, the AGPL-3.0 / MIT license split, and repository invariant tests.
- Updated dependencies [5f7bace]
- Updated dependencies [803f280]
- Updated dependencies [9d8ca25]
- Updated dependencies [ed5ab78]
- Updated dependencies [b7d9c3a]
- Updated dependencies [027121b]
- Updated dependencies [85b6bb8]
- Updated dependencies [ae3e4ab]
- Updated dependencies
- Updated dependencies [b55c1a4]
- Updated dependencies [833ab7d]
- Updated dependencies [45c4eee]
- Updated dependencies [eaa6104]
- Updated dependencies [e05fb7a]
- Updated dependencies [3ab9ae7]
- Updated dependencies [62de53e]
- Updated dependencies [1d93dfb]
  - @perch/api@0.1.0
  - @perch/vault@0.0.1
  - @perch/db@0.0.1
  - @perch/runner@0.0.1
