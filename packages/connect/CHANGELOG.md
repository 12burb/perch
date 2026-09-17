# @perch/connect

## 0.2.0

### Minor Changes

- 8362875: Connectors are files. Point `PERCH_CONNECTORS_DIR` at a directory of `<id>/manifest.yaml` and those
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
- d2ea19a: The rest of the §5.5 seed connectors: Google Workspace, Jira, Cloudflare, Railway, Netlify, HeyGen
  and X, each one's lanes, test call, account field and webhook signature read off that provider's own
  documentation. Seventeen ship now, and `perch connectors check` passes on all of them.
  
  Webhook verification grew three schemes to match what those providers actually do: **Ed25519**, so
  Discord's deliveries can be verified at last (paste Discord's public key into Perch rather than a
  Perch secret into Discord), a **shared secret in a header** for Cloudflare and Google — which proves
  who sent a delivery and not what they sent, and says so — and Netlify's **signed JWT**, checked
  against the body's digest.
- 602fa1f: Runner-local MCP servers. A project can ship its own tools — a command in the repository — and
  Perch runs them where the project is: the runner spawns the process, the api speaks MCP down the
  stream it answers with, and `/mcp/{id}` looks exactly like a connection's server. A bot attaches
  one by naming it in its spec. No port, no token, no vault entry: the gate is the workspace, the
  spec, and the runner's own policy on the command.
- 50d8ab9: A provider can tell Perch when something happens. Make an endpoint for GitHub, Vercel or Clerk, paste
  its URL and its one-time secret into the provider, and every signed delivery becomes a card in the
  channel you wired it to — what happened, who did it, and a link. An unsigned delivery, or one signed
  with anything else, is refused and posts nothing; the same delivery twice is one card. Bots can wait
  for them too: a `webhook` trigger fires on a delivery and the bot answers in the card's own thread.

### Patch Changes

- Updated dependencies [8362875]
- Updated dependencies [d2ea19a]
  - @perch/connectors@0.2.0

## 0.1.0

### Minor Changes

- 9c29082: Connections, part one: the core of connecting a service. A connector is a manifest.yaml describing
  one provider — its lanes, its API base, the scopes to ask for — and GitHub's ships with Perch. You
  can paste a personal access token or install a GitHub App, and either way the secret goes into the
  vault and never comes back out to a caller: a connection shows the account it speaks as and a hint
  like `gi…wxyz`, nothing more. An App connection stores only the private key and mints a fresh
  installation token for each call. Cloning a project can now run on a connection, with the token
  minted for that one clone. The instance publishes its OAuth client metadata document at
  `/.well-known/oauth-client-metadata.json`, whose URL is the client_id it declares.
- d6528a4: Connections v2: connect anything with a remote MCP server without registering an app first. Perch
  discovers how to authorize at the moment you click Connect — the protected-resource document
  (RFC 9728), the authorization server's metadata (RFC 8414 or OpenID Connect discovery), then who
  Perch is as a client: an app you registered here, this instance's own client metadata document, or
  a client registered on the spot (RFC 7591) — and completes an OAuth 2.1 round-trip with PKCE and a
  resource indicator naming the server the token is for.
  
  Vercel, Supabase and Clerk ship as connectors. **Use my own app** registers your own OAuth client
  with a provider on either sign-in lane, and **Who may use it** on every connection grants it to a
  bot: a connection that is yours can be lent to a bot the whole workspace talks to only on your
  behalf, and both the grant and the call are refused otherwise.
- 3318f0e: Ship from the IDE, and look at your database while you are there. The drawer has two new tabs.
  **Deploy** builds the project's branch through a Vercel connection and posts a card in the channel
  you choose; the card is the deploy's record, rewritten in place as the build moves, so the preview
  URL appears in the message that announced it rather than in a second one underneath.
  
  **Database** lists the tables and columns of a connection's database and runs one statement. It goes
  through Perch's MCP gateway on the connection's own token, so nothing new touches a credential, and
  it is read-only: a statement that writes is refused before the provider is asked, with the rule that
  said so. Which tools a provider's database is browsed with comes from its connector manifest.
- fb30b24: Agents can use a connection's tools without ever holding its credential. Every connection whose
  provider has an MCP server is now one itself, at `/mcp/{connectionId}`: a session is handed that
  URL and a token Perch minted for it, and Perch attaches the provider's real credential on the way
  out. A grant's allow-list decides which tools a session may call — a refusal never reaches the
  provider — and every call is audited with the tool, the caller, and a hash of its arguments. A
  connection may override its provider's MCP URL for a self-hosted host, the way it already can for
  the REST API.

### Patch Changes

- Updated dependencies [9c29082]
- Updated dependencies [d6528a4]
- Updated dependencies [3318f0e]
  - @perch/connectors@0.1.0

## 0.0.1

### Patch Changes

- e05fb7a: Resolve and pin every dependency named in the spec (docs/dependencies.md), with ADR-0019..0028 for the non-obvious picks; commit the lockfile.
