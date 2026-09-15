---
"@perch/connect": minor
"@perch/connectors": minor
"@perch/api": minor
"@perch/db": minor
"@perch/policy": minor
---

Connections, part one: the core of connecting a service. A connector is a manifest.yaml describing
one provider — its lanes, its API base, the scopes to ask for — and GitHub's ships with Perch. You
can paste a personal access token or install a GitHub App, and either way the secret goes into the
vault and never comes back out to a caller: a connection shows the account it speaks as and a hint
like `gi…wxyz`, nothing more. An App connection stores only the private key and mints a fresh
installation token for each call. Cloning a project can now run on a connection, with the token
minted for that one clone. The instance publishes its OAuth client metadata document at
`/.well-known/oauth-client-metadata.json`, whose URL is the client_id it declares.
