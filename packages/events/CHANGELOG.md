# @perch/events

## 0.0.2

### Patch Changes

- ea81bde: The runner control channel (spec §7.6): runners connect to `/api/runner` with a connect token, register,
  heartbeat, and answer api requests that carry per-request capability tokens; the runner image now runs
  the runner agent as its entrypoint (`PERCH_API_URL`, `PERCH_RUNNER_TOKEN`).

## 0.0.1

### Patch Changes

- 027121b: Core packages: the spec §7 contracts as Zod (bus event catalog, WS protocol, runner JSON-RPC, EngineEvent, error shape); an in-process bus with per-topic replay; a Postgres job queue with SKIP LOCKED claims, backoff, cron, and crash recovery; envelope encryption with rotation. Adds the jobs table (migration 0002).
- 45c4eee: Laptop mode (task 0.14): `perch dev` runs the api, the web app, and an in-process runner on PGlite under
  `~/.perch`; `perch doctor` checks the machine and the data directory; `perch backup` and `perch restore`
  round-trip the PGlite data, files, and master key as a backup directory. `RunnerLink` in `@perch/events`
  and the api's runner registry (`GET /api/health` now reports `checks.runners` and `mode`) are the seam
  the hosted and local runners plug into next.
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
