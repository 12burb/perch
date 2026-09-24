---
"@perch/api": patch
"@perch/cli": patch
---

The request edge is stricter (ADR-0172).

- An api token keeps its scopes and workspace binding on every route. It can no longer mint
  tokens, which takes a signed-in session. A bound token lists only its own workspace and sees only
  that workspace's inbox. Account-wide and instance-wide changes (profile, tokens, new workspaces,
  the admin pages) take a session or an unbound `admin` token.
- A write or WebSocket upgrade authenticated by the session cookie must come from Perch's own
  origin. A same-site preview page can no longer act as the person viewing it. A JSON route that
  gets a body of another media type answers 415 in the usual error shape instead of 500.
- Requests addressed to a host name the instance does not answer to are refused, which protects
  laptop and private-network instances from DNS rebinding. Extra names go in `PERCH_ALLOWED_HOSTS`.
- `X-Forwarded-For` is believed only from trusted proxies (`PERCH_TRUSTED_PROXIES`; loopback
  always, `caddy` in the compose file). Audit addresses and sign-in rate limits can no longer be
  spoofed.
- First-run setup is claimed atomically: of two concurrent wizards, one wins and the other gets 409.
- A workspace can no longer remove the instance's shared runner.
- Invite and password-reset mail is sent over `PERCH_SMTP_URL` (with `PERCH_SMTP_FROM`). The
  links, which carry tokens, are never logged, and neither is a token in a request path.
- Log redaction now works at any depth and on camelCase names. `PERCH_LOG_PRETTY=on` works in the
  published image and the compiled binary instead of crashing it.
