# @perch/cli

## 0.1.1

### Patch Changes

- Updated dependencies [ea81bde]
  - @perch/runner@0.1.0
  - @perch/api@0.1.1

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
