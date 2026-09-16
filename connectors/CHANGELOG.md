# @perch/connectors

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
