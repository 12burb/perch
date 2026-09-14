# @perch/ui

## 0.0.1

### Patch Changes

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
- 1e8a4fa: `@perch/ui` (task 0.11): the §4 design tokens (dark-first + light, density, motion, semantic colors) with
  the Tailwind v4 theme mapping, `useTheme`, the shadcn-style base (Button, IconButton, Input, Textarea,
  Label, Field, Separator, Badge, BotBadge, Avatar, Kbd, Tooltip, Dialog, Sheet), and the shell components
  (Shell, Rail, Sidebar, Panel, Drawer, MobileTabBar, Peek, CommandPalette, Composer skeleton, EmptyState),
  each with Playwright component tests at 1440 px and 390 px that pass axe.
- 905d933: The web shell (task 0.12): the §4 layout on every signed-in page with the six rail tabs (Home, Code,
  Work, Bots, Inbox, Search) under `/$workspace/$mode`, the mobile tab bar with a More sheet, per-mode
  sidebars and one-line empty states, the command palette (⌘K), a workspace switcher, a welcome page that
  creates the first workspace, and settings for the profile (name, handle, locale, time zone, theme,
  density), security (passkeys, api tokens), and the workspace (name, slug, members and roles, invites,
  audit log). Screenshots at 1440 px and 390 px live in docs/screenshots/0.12.
- 1d93dfb: WebSocket server at `/api/ws` (task 0.10, spec §7.2): subscribe/unsubscribe with per-topic
  authorization, `resume { topic, after_seq }` from the replay buffer (or `resync` when it fell off),
  presence per user per workspace with a `presence_snapshot` on subscribe, rate-limited typing on channel
  topics, and the web client (`PerchSocket`, `usePresence`) showing who is online per workspace.
