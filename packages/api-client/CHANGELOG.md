# @perch/api-client

## 0.1.0

### Minor Changes

- b144df4: Review what an agent changed: a Changes view in the session pane shows the diff of one turn or of
  the whole session, with labelled hunks you accept or reject one at a time, Accept all / Reject all
  per file, and Open to jump to the file. Rejecting a hunk takes just those lines back out. Every
  turn now takes a checkpoint of the project first, so any turn can be restored from the transcript,
  and a code block in a reply can be applied to the file its fence names.
- df9ec50: The editor: open a project from Code mode to browse its file tree, edit files in CodeMirror 6 with
  tabs and breadcrumbs, save with ⌘S, search the project, and preview markdown and images; the api
  gains per-project file routes that forward to the project's runner.
- a837eea: ⌘K in the editor rewrites a selection: describe the edit, and the agent's version lands in the
  buffer with the replaced lines struck through above it. Accept keeps it and ⌘S writes it; Reject
  puts the original back. Nothing touches the file until you save, and the lane the agent answers on
  stays out of the session list.
- f3aefb9: Projects: create one empty, upload files into one, or clone a repository (public, with an access
  token, or with the workspace's SSH deploy key) from Code mode or the API; the directory is set up on
  a runner, `.perch/project.json` is validated and applied, `devcontainer.json` is read and its
  `postCreateCommand` runs, and the row's status updates live.
- 0d33a89: Runners answer the fs (list, read, write, stat, ripgrep-backed search), git (status, diff, commit,
  push, branch, worktrees), ports, and exec methods, every call through a policy hook with built-in
  rules (destructive commands, publishes, force pushes, git internals, exec confined to the projects
  root); the Environments list shows each runner's listening ports and the api answers them live.
- 3764521: The session pane: start a session from Code mode's sidebar, watch the transcript stream with
  collapsed tool cards and diffs, answer permission prompts (Allow once / Always this session /
  Deny), switch between plan and build, see tokens and cost, rename and fork sessions; the api gains
  rename and fork routes.
- cc5c90d: Sessions: the Engine interface with a fake engine and a runner-hosted bridge, the
  coding_sessions/session_events tables, and api routes to open a session in a project, send turns,
  answer permissions, cancel, and replay the transcript from a seq; every event fans out live on the
  session's WS topic.

## 0.0.1

### Patch Changes

- 9d8ca25: apps/api skeleton: Hono + zod-openapi with the OpenAPI document at /api/openapi.json, the §7.8 error model with request ids, pino request logging with secret redaction, Perch-Version handling, GET /api/health and /api/version, boot wiring (env → db migrations → bus, vault, queue), and the generated TypeScript client (@perch/api-client) typed end to end.
- ed5ab78: Authentication (task 0.8): better-auth on the Drizzle adapter with email + password, passkeys
  (`@better-auth/passkey`, bound to `PERCH_PUBLIC_URL`), and generic OIDC through `PERCH_OIDC_*`; a Perch
  `users` profile row for every auth user; `GET/PATCH /api/me`; api tokens (`/api/me/tokens`, shown once,
  stored hashed, accepted as `Bearer pat_…`); workspaces with owner memberships; email invites
  (`POST /api/workspaces/{ws}/invites`, public preview, accept bound to the invited email); a public
  `GET /api/instance`; the first web routes (sign in, sign up, invite, security settings) with `t()` strings
  and design tokens from `@perch/ui`; Playwright e2e (`bun run e2e`) covering sign up, passkey sign-in, api
  tokens, and invite acceptance at 1440 px and 390 px.
- ae3e4ab: Deploy (task 0.13): `deploy/Dockerfile.api` (Bun runtime, Vite build under Node, non-root, `api | worker |
  supervisor`), `deploy/Dockerfile.runner` (the Ubuntu 24.04 runner base), `deploy/Dockerfile.caddy`
  (Caddy with a DNS-challenge module), the pinned `docker-compose.yml` with the `local` and `tunnel`
  profiles, the Caddyfiles, `.env.example`, `perch init` (writes `.env` with generated secrets, the compose
  file, and the Caddyfile), and the setup wizard: `POST /api/setup` creates the admin, the first workspace,
  confirms `PERCH_PUBLIC_URL`, records the telemetry choice, and sign-ups stay closed until it has run.
- e05fb7a: Resolve and pin every dependency named in the spec (docs/dependencies.md), with ADR-0019..0028 for the non-obvious picks; commit the lockfile.
- 62de53e: Workspaces, memberships, RBAC, and the audit log (task 0.9): `authorize(ctx, action, resource)` in
  `@perch/policy` (role matrix + token scopes) applied in every workspace handler, with non-members getting
  `not_found`; `GET/PATCH /api/workspaces/{ws}`, `GET /api/workspaces/{ws}/members`,
  `PATCH/DELETE /api/workspaces/{ws}/members/{user}` (owner rules, last-owner protection, leave);
  the `audit_log` table (migration 0003) written by a bus subscriber for every workspace event, with
  `GET /api/workspaces/{ws}/audit`; bus envelopes now carry `meta` (request id, client ip).
