---
"@perch/api": patch
"@perch/api-client": patch
"@perch/web": patch
"@perch/ui": patch
---

Authentication (task 0.8): better-auth on the Drizzle adapter with email + password, passkeys
(`@better-auth/passkey`, bound to `PERCH_PUBLIC_URL`), and generic OIDC through `PERCH_OIDC_*`; a Perch
`users` profile row for every auth user; `GET/PATCH /api/me`; api tokens (`/api/me/tokens`, shown once,
stored hashed, accepted as `Bearer pat_…`); workspaces with owner memberships; email invites
(`POST /api/workspaces/{ws}/invites`, public preview, accept bound to the invited email); a public
`GET /api/instance`; the first web routes (sign in, sign up, invite, security settings) with `t()` strings
and design tokens from `@perch/ui`; Playwright e2e (`bun run e2e`) covering sign up, passkey sign-in, api
tokens, and invite acceptance at 1440 px and 390 px.
