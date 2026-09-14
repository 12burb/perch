# @perch/runner

## 0.1.0

### Minor Changes

- ea81bde: The runner control channel (spec §7.6): runners connect to `/api/runner` with a connect token, register,
  heartbeat, and answer api requests that carry per-request capability tokens; the runner image now runs
  the runner agent as its entrypoint (`PERCH_API_URL`, `PERCH_RUNNER_TOKEN`).

### Patch Changes

- Updated dependencies [ea81bde]
  - @perch/events@0.0.2

## 0.0.1

### Patch Changes

- 45c4eee: Laptop mode (task 0.14): `perch dev` runs the api, the web app, and an in-process runner on PGlite under
  `~/.perch`; `perch doctor` checks the machine and the data directory; `perch backup` and `perch restore`
  round-trip the PGlite data, files, and master key as a backup directory. `RunnerLink` in `@perch/events`
  and the api's runner registry (`GET /api/health` now reports `checks.runners` and `mode`) are the seam
  the hosted and local runners plug into next.
- eaa6104: Phase 0 spikes with recorded outcomes: bun-pty replaces node-pty on Bun (ADR-0029); the ACP SDK, OpenCode SDK, PGlite with pgvector, the QuickJS sandbox, better-auth with the Drizzle adapter, and the preview tunnel over an outbound runner socket are verified; dockerode, the Caddy wildcard, and cloudflared are gated on CI resources (ADR-0030..0038).
- e05fb7a: Resolve and pin every dependency named in the spec (docs/dependencies.md), with ADR-0019..0028 for the non-obvious picks; commit the lockfile.
- 3ab9ae7: Scaffold the monorepo: Bun workspaces, Turborepo, Biome, strict TypeScript, Changesets, Renovate, PR and issue templates, the AGPL-3.0 / MIT license split, and repository invariant tests.
- Updated dependencies [027121b]
- Updated dependencies [45c4eee]
- Updated dependencies [62de53e]
- Updated dependencies [1d93dfb]
  - @perch/events@0.0.1
