# @perch/bus

## 0.0.2

### Patch Changes

- Updated dependencies [378589c]
- Updated dependencies [347ce60]
- Updated dependencies [3318f0e]
- Updated dependencies [b144df4]
- Updated dependencies [a837eea]
- Updated dependencies [a451282]
- Updated dependencies [de84546]
- Updated dependencies [fb30b24]
- Updated dependencies [5f61320]
- Updated dependencies [c4e921c]
- Updated dependencies [f3aefb9]
- Updated dependencies [eb5cdaa]
- Updated dependencies [ea81bde]
- Updated dependencies [0d33a89]
- Updated dependencies [cc5c90d]
- Updated dependencies [a438fc6]
- Updated dependencies [f0ff645]
  - @perch/events@0.1.0

## 0.0.1

### Patch Changes

- 027121b: Core packages: the spec §7 contracts as Zod (bus event catalog, WS protocol, runner JSON-RPC, EngineEvent, error shape); an in-process bus with per-topic replay; a Postgres job queue with SKIP LOCKED claims, backoff, cron, and crash recovery; envelope encryption with rotation. Adds the jobs table (migration 0002).
- 62de53e: Workspaces, memberships, RBAC, and the audit log (task 0.9): `authorize(ctx, action, resource)` in
  `@perch/policy` (role matrix + token scopes) applied in every workspace handler, with non-members getting
  `not_found`; `GET/PATCH /api/workspaces/{ws}`, `GET /api/workspaces/{ws}/members`,
  `PATCH/DELETE /api/workspaces/{ws}/members/{user}` (owner rules, last-owner protection, leave);
  the `audit_log` table (migration 0003) written by a bus subscriber for every workspace event, with
  `GET /api/workspaces/{ws}/audit`; bus envelopes now carry `meta` (request id, client ip).
- Updated dependencies [027121b]
- Updated dependencies [45c4eee]
- Updated dependencies [62de53e]
- Updated dependencies [1d93dfb]
  - @perch/events@0.0.1
