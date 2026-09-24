# @perch/web

React 19 + Vite 8 PWA: the Perch shell (spec §4). File-based routes with TanStack Router
(`src/routes/*`, tree generated into `src/routeTree.gen.ts` and committed), TanStack Query for data,
Tailwind v4 over the `@perch/ui` tokens and components, `better-auth/react` for sessions and passkeys,
the typed `@perch/api-client` for everything under `/api`, and `src/lib/ws.ts` (`PerchSocket`,
`usePresence`) for the §7.2 WebSocket.

```sh
bun run --filter @perch/web dev      # Vite on :5173, /api proxied to the api on :3000
bun run --filter @perch/web build    # dist/ (served by apps/api when present)
bun run e2e                          # Playwright against the built app (see the root README)
E2E_SCREENSHOTS=1 bun run e2e        # also refreshes docs/screenshots/0.12 (1440 px and 390 px)
```

| Route | What |
|---|---|
| `/` | redirects to the last workspace's Home, the first membership, or `/welcome` |
| `/sign-in`, `/sign-up`, `/invite/$token` | standalone auth pages; signing in, signing up and signing out each end in a full page load (`src/lib/fresh-start.ts`), so nothing one person's session held in memory is shown to the next one in the same tab (ADR-0178) |
| `/welcome` | create the first (or another) workspace |
| `/$workspace/home` … `/search` | the six rail tabs: Home (members with presence), Code, Work, Bots, Inbox, Search, each with its sidebar sections and empty state |
| `/$workspace/settings` | workspace name and slug (never one of the app's own top-level paths: `settings`, `welcome`, `sign-in`, `api`, …), members and roles, invites, audit log |
| `/settings/profile`, `/settings/security` | name, handle, locale, time zone, theme and density; passkeys and api tokens |

`src/shell/app-shell.tsx` wires the `@perch/ui` Shell to routing: rail tabs as links, the mobile tab bar
with a More sheet, per-mode sidebars, ⌘K palette, ⌘B/⌘./⌘J region toggles remembered per mode, the
workspace switcher, and the account menu (ADR-0056). Every string goes through `t("key")`; every page
has landmarks and an h1 and passes axe in the e2e suite at 390 px and 1440 px.
