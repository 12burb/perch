---
"@perch/connect": minor
"@perch/connectors": minor
"@perch/api": minor
"@perch/cli": minor
---

Connectors are files. Point `PERCH_CONNECTORS_DIR` at a directory of `<id>/manifest.yaml` and those
providers appear in Connections at the next boot, with the paste lane, the sign-in lane, the test
call, the MCP server and the webhook scheme all read off the file — a connector can now be added,
or a broken built-in one corrected, without a fork and without waiting for a release.

Six more ship in the box: Slack, Stripe, Linear, Notion, Sentry and Discord, alongside GitHub,
Vercel, Supabase and Clerk. Making them work meant the manifest could say more: `token_scheme: raw`
for a provider that wants the token without `Bearer` in front of it, `headers:` for one that needs
its own on every call, and `webhook.timestamp_prefix` for Stripe's `t=<ts>,v1=<hex>`, where the
signed timestamp rides inside the signature header. `webhook.id_header` and `event_header` are now
optional, because a provider that puts neither in a header — Slack, Stripe — is normal.

`perch connectors check <dir>` is the harness. It parses a manifest and then exercises what it
claims: a delivery signed by its own scheme must verify, the same delivery with a byte changed must
not, and somebody else's secret must not. It says when a lane does not add up, and it says out loud
when a provider signs nothing at all, which three of them really do. Every connector in this repo
goes through it in CI.

OAuth tokens now refresh. A connection whose access token expires within the next minute is swapped
before the call that needed it goes out, on the same app it was made with; one nobody is using is
left alone. A refresh the provider refuses marks the connection Not accepted rather than failing a
moment later with something less useful.
