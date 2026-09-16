---
"@perch/connect": minor
"@perch/connectors": minor
"@perch/api": minor
---

The rest of the §5.5 seed connectors: Google Workspace, Jira, Cloudflare, Railway, Netlify, HeyGen
and X, each one's lanes, test call, account field and webhook signature read off that provider's own
documentation. Seventeen ship now, and `perch connectors check` passes on all of them.

Webhook verification grew three schemes to match what those providers actually do: **Ed25519**, so
Discord's deliveries can be verified at last (paste Discord's public key into Perch rather than a
Perch secret into Discord), a **shared secret in a header** for Cloudflare and Google — which proves
who sent a delivery and not what they sent, and says so — and Netlify's **signed JWT**, checked
against the body's digest.
