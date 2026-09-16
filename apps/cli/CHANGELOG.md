# @perch/cli

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
