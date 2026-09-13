# @perch/web

React 19 + Vite 8 PWA: the Perch shell (spec §4). File-based routes with TanStack Router
(`src/routes/*`, tree generated into `src/routeTree.gen.ts` and committed), TanStack Query for data,
Tailwind v4 over the `@perch/ui` tokens, `better-auth/react` for sessions and passkeys, the typed
`@perch/api-client` for everything under `/api`, and `src/lib/ws.ts` (`PerchSocket`, `usePresence`) for
the §7.2 WebSocket: subscriptions with per-topic seqs, resume after reconnect, presence heartbeat.

```sh
bun run --filter @perch/web dev      # Vite on :5173, /api proxied to the api on :3000
bun run --filter @perch/web build    # dist/ (served by apps/api when present)
bun run e2e                          # Playwright against the built app (see the root README)
```

| Route | What |
|---|---|
| `/` | your workspaces with who is online (over `/api/ws`) and "create workspace" (redirects to sign-in when signed out) |
| `/sign-in`, `/sign-up` | email + password, passkey sign-in, single sign-on when the instance has OIDC |
| `/invite/$token` | invite preview; accept as the signed-in user whose email matches |
| `/settings/security` | passkeys (add, remove) and api tokens (create once, revoke) |

Every string goes through `t("key")` from `@perch/ui`; every control has a label; every flow works at
390 px (the mobile Playwright project) and 1440 px. Task 0.12 replaces this placeholder layout with the
§4 shell (rail, sidebar, panel, drawer).
