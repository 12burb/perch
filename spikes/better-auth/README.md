# Spike 0.4.6 — better-auth on Bun

**Pass criterion:** email + password, passkeys, and generic OIDC flows pass Playwright.

**Outcome (ADR-0034): pass at the HTTP level; the browser passkey ceremony is task 0.8's Playwright spec.**
better-auth 1.7.4 with the Drizzle adapter on PGlite runs on Bun through `auth.handler(Request)`:

- email + password: sign up, sign in (session cookie), `get-session`, wrong password → 401;
- passkeys (`@better-auth/passkey` 1.7.4): `generate-register-options` returns WebAuthn options for the
  configured rp, `list-user-passkeys` works;
- generic OIDC (`genericOAuth` with `discoveryUrl`): discovery against an in-process OpenID provider
  (`oauth2-mock-server`), authorization-code + PKCE, callback, session with the provider's claims.

Two facts learned: better-auth 1.7 registers generic OAuth providers as social providers, so the routes are
the core `POST /sign-in/social` and `GET /callback/:providerId` (there is no `/sign-in/oauth2`); and the
plugin's own tables (`schema.ts`) use better-auth's field names verbatim so the adapter needs no mapping.
Task 0.5 moves `schema.ts` into `packages/db` as the `auth_*` tables.

```sh
bun test spikes/better-auth
```
