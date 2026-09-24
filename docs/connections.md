# Connections: reaching other services

A **connection** is how Perch acts on your behalf somewhere else — cloning a repository, pushing a
branch, opening a pull request. The credential lives in the instance's vault and is never read back
out: not to you, not to an agent, not to a log line (spec §3.5, AGENTS.md §1.6; task 1.16,
ADR-0082).

## Where it lives

Workspace settings → **Connections**. Each row shows the service, the account it speaks as, who may
use it, and whether it still works. **Test** asks the provider; **Disconnect** removes it.

## The lanes

A service offers one or more ways to connect, listed strongest identity first. Which ones you see
comes from that service's manifest, so a new connector needs no new code.

| Lane | What it is | When to use it |
|---|---|---|
| **Install an app** | A GitHub App. Perch keeps the app's private key and mints a short-lived installation token for each call. | A workspace's repositories. It is the only lane that gets webhooks and check runs. |
| **Sign in through its MCP server** | OAuth 2.1 with PKCE against whichever authorization server the provider's MCP server names, discovered at the moment you click Connect. | Anything with a remote MCP server: Vercel, Supabase, Clerk. Nothing to register first. |
| **Sign in** | OAuth 2.1 with PKCE, through an app this instance registered with the provider. | Your own account, when the provider has an OAuth app you can register. |
| **Paste a token** | A personal access token or API key. Always available, whatever else a service offers. | The quickest path, and the fallback when nothing else fits. |

A pasted token is checked against the provider before it is kept, so a wrong paste is caught here
rather than at the first clone. A paste from the wrong field — an OpenAI key into GitHub, say — is
refused on its shape before Perch asks anyone anything.

**API base** is where the service lives, for anyone running it themselves: a GitHub Enterprise
Server, a GitLab of your own. An empty box means the public one. It is stored with the connection,
so every call Perch makes on it — the check above, a clone, a push, a pull request — goes there.

An API base or MCP server you type is fetched by Perch's api, from the api's own network, so on a
team instance it has to be a **public address** (ADR-0173): a URL whose host is, or resolves to,
loopback, a private range, link-local (the cloud metadata address among them), carrier-grade NAT
or an IPv6 form of any of those is refused with a `422` naming the field, before anything is
called or kept. Redirects are followed one hop at a time and each hop is checked the same way. In
laptop mode, where the network is your own, private addresses are allowed; an operator running a
team instance next to a self-hosted provider on a private network can allow them too with
`PERCH_OUTBOUND_ALLOW_PRIVATE=on`. A connector's own manifest endpoints are the operator's choice
and are not checked.

### Setting up a GitHub App

GitHub's remote MCP has no dynamic client registration, so an app is the way to give Perch a real
identity there. The Connections card gives you what GitHub's form asks for:

- **Callback URL** — `<your Perch>/api/connect/callback/github`, prefilled.
- **Webhook URL** and **Webhook secret** — choose the channel the app's cards should go to and
  press **Make webhook endpoint**. That makes an [inbound webhook](#inbound-webhooks) for GitHub
  (an admin's call, like every webhook), and the card shows its URL,
  `<your Perch>/hooks/github/<endpoint id>`, and its secret — **shown this once**, so paste both
  into the app's webhook settings straight away.

Create the app on GitHub with those, install it on the repositories you want, then paste its **App
ID**, its **private key**, and the **installation ID** into the card. Perch stores only the private
key; every token it uses is minted from that key for one call and expires within the hour.

### Signing in through an MCP server

This is the lane that needs nothing set up. Click Connect and Perch asks the provider's own MCP
server three questions, in the order the MCP authorization spec gives them:

1. **Which authorization server guards this?** The protected-resource document at
   `/.well-known/oauth-protected-resource/<path>` (RFC 9728). A server that publishes none is asked
   directly: its `401` names the document in `WWW-Authenticate`, which is what an implementation
   older than RFC 9728 gives you.
2. **Where are that server's endpoints?** `/.well-known/oauth-authorization-server` (RFC 8414),
   then OpenID Connect discovery, tried in both of the layouts the specs allow.
3. **Who are we, as a client?** In this order: an app somebody registered here (below), then this
   instance's own client metadata document when the server takes one (CIMD), then a client
   registered on the spot (RFC 7591). A server that offers none of the three leaves the paste lane,
   which every provider always has.

Each answer is held to its own standard before it is used. A protected-resource document that
names some other resource than the server asked about is passed over (RFC 9728 §3.3), whether it
was found at the well-known path or through a `401`'s pointer; an authorization server's document
whose `issuer` is not the one asked about is passed over (RFC 8414 §3.3); and one whose
authorization, token, registration or revocation endpoint is plain `http` anywhere but this machine
is passed over too, since a code, a token or a client secret would travel there.

Then it is an ordinary OAuth 2.1 round-trip: PKCE with `S256`, and a `resource` parameter naming
the MCP server the token is for, so a token minted for one server cannot be replayed at another
(RFC 8707). The access token and its refresh token go into the vault — and, for a client the server
registered on the spot, the secret it issued, which a refresh needs again; the card shows the lane
the connection was made on and nothing else. The connection's MCP server is the one the manifest
names, or the one you typed — never whatever a metadata document called itself.

**MCP server** is the same escape hatch **API base** is: leave it empty for the provider's public
server, fill it in for one you host yourself.

### Finishing a sign-in

The provider sends you back to `/api/connect/callback/<provider>` with the state Perch gave you when
you pressed Connect. Perch finishes only for **the person who started it, in a browser signed in to
Perch as them**, and only on the provider it was started for (RFC 6749 §10.12). An authorize link
opened by somebody else — sent on, or pasted into the wrong window — is refused, and so is a
browser with no Perch session: the state is spent either way, the code is never traded, and nobody's
account is attached to a connection its owner did not start. A flow started from the SDK or the
CLI is finished the same way, in a browser signed in as you. The connection is recorded as made by
whoever started it.

### Using your own app

**Use my own app** appears on both sign-in lanes. Register an OAuth app with the provider, give it
the callback URL shown in the card, and paste the client id — and the secret, if the provider issued
one, which is sealed in the vault like any other credential. Perch prefers that app over registering
one itself, which is what you want when the provider's dashboard is where your organisation's
audit trail lives.

On the MCP lane the registered app is used only with **the provider's own MCP server** — the one
its manifest names. An MCP server somebody types in is somewhere the app was never registered, and
its metadata could name any token endpoint at all, so a sign-in through one uses this instance's
client metadata document or a client that server registers, never the workspace's app or its secret
(ADR-0173). Refreshes follow the same rule.

## Who may use a connection

Every row has **Who may use it**. A connection reaches nothing on its own; something has to be
granted it — a bot today, an automation later.

One rule governs the interesting case. A connection that belongs to **you** may be granted to a bot
**the whole workspace can talk to** only *on your behalf*: the grant carries that flag, and the
gateway refuses the call when the person who set the bot running is not you. Anything else is
refused outright, with a 403 that says so. A bot that is yours alone, or a connection the workspace
owns, has no such restriction — this is the rule that stops "ask the shared bot to do it" from
becoming a way to borrow somebody's login (spec §3.5, AGENTS.md §1.6).

A grant can also mark some of its tools **requires_permission** (spec §3.5). Those stay in the
bot's toolbox, but calling one parks the call and asks a person — a card in the thread and an item
in their inbox — and it runs only once somebody says yes. See
[Tools from an MCP server](bots.md#tools-from-an-mcp-server). A bot outside Perch calling over the
Bot API has nobody to ask, so such a tool is refused to it outright.

Granting a connection the **workspace** owns, or taking such a grant away, is an admin's call
(`connections.admin`), like disconnecting it; a member grants only their own connections. Revoking
a grant names the connection it is on, and finds nothing on any other.

Taking a grant away takes effect on the next call: nothing is cached past the request that used it.

## Scope

A connection is personal by default: it is invisible to everyone else in the workspace, and no
session but yours can use it. An admin can connect on the workspace's behalf instead, which is what
a shared bot or an automation runs on (spec §3.5: anything shared runs on a service identity, never
on someone's personal login).

## What a connection can do today

- **Clone a project.** Choose a connection when cloning and Perch mints the token for that one
  clone. It is handed to the runner for the checkout and never written down.
- **Open a pull request.** `POST /api/workspaces/{ws}/projects/{p}/pull-request` pushes the branch
  and asks the provider to open the PR, both on the same short-lived credential. The Git panel's
  button for this arrives with task 1.20.
- **Give an agent its tools.** A connection whose provider has an MCP server becomes one itself, at
  `/mcp/{connectionId}`. Sessions you start reach it with a token of Perch's, never with yours —
  see [the MCP gateway](./mcp-gateway.md).

## This instance as an OAuth client

Perch publishes its client metadata document at `/.well-known/oauth-client-metadata.json`, and that
URL is the `client_id` it presents — the CIMD path that has been the MCP auth spec's primary
registration route since July 2026. Everything in the document is derived from `PERCH_PUBLIC_URL`,
so a self-hosted instance is correct without configuring anything. Perch declares no client secret,
because a self-hosted instance has none a provider could have issued it.

## Roles

| Action | owner | admin | member |
|---|---|---|---|
| See the connections you may use | ✅ | ✅ | ✅ |
| Connect and disconnect your own account | ✅ | ✅ | ✅ |
| Connect on the workspace's behalf | ✅ | ✅ | ❌ |
| Register an app with a provider | ✅ | ✅ | ❌ |
| Grant a connection you may use to a bot | ✅ | ✅ | ✅ |

## Tokens that expire

A connection made through the **Sign in** lane usually comes with an access token that runs out in
an hour and a refresh token that does not. Perch swaps it **on use**: when a call is about to go out
on a connection that expires within the next minute, it asks the provider for a new one first, keeps
it, and makes the call with it. A connection nobody is using is left alone — there is no timer and
no queue to run (ADR-0127).

The refresh goes out on the same app the connection was made with: your own registered client where
there is one, else the client the provider issued through dynamic registration. If the provider
refuses — a refresh token revoked, an app deleted — the connection is marked **Not accepted** and
the call fails with that, rather than with whatever the provider says a moment later to a token it
has already rejected.

A connection made through **Sign in through its MCP server** refreshes the same way, at the token
endpoint discovery found when it was made, as the client it was made with — with the secret that
client was issued, sealed with the connection — and naming the same resource (ADR-0173).

One refresh runs at a time per connection: calls that arrive while it is out wait for its answer
rather than spending the same refresh token again, which a provider that rotates refresh tokens
would refuse. And a refusal is not taken at its word if what is stored changed while the refresh
was out — another api process refreshed first, spending the token this one used — in which case
its fresh token is used and the connection stays **Active**.

## Disconnecting

**Disconnect** hands the tokens back to the provider before Perch forgets them (spec §3.5 "revoke
on disconnect"; ADR-0173):

- a connection made through **Sign in through its MCP server** is revoked at the RFC 7009 endpoint
  its authorization server names — the refresh token, which ends the whole grant;
- a GitHub connection made through **Sign in** deletes its grant through GitHub's API
  (`DELETE /applications/{client_id}/grant`), as the app you registered;
- other providers' manifests name no revocation endpoint, and a pasted token or an app installation
  is yours to revoke where you made it.

Handing back is best effort: a provider that is down or refuses is logged, and the connection is
removed from Perch either way.

## Connectors

A connector is a directory with a `manifest.yaml`: the lanes it offers, its API base, the token
prefixes a paste should have, the call that proves a connection works, its MCP server, its OAuth
endpoints, and how it signs a webhook. Nothing about it is code.

Seventeen ship today — the whole §5.5 seed list:

| Connector | Lanes | MCP server |
|---|---|---|
| **GitHub** | Install an app, Sign in, Paste a token | `https://api.githubcopilot.com/mcp/` |
| **Vercel** | Sign in through its MCP server, Paste a token | `https://mcp.vercel.com` |
| **Supabase** | Sign in through its MCP server, Paste a token | `https://mcp.supabase.com/mcp` |
| **Clerk** | Sign in through its MCP server, Paste a token | `https://mcp.clerk.com/mcp` |
| **Slack** | Sign in, Paste a token | — |
| **Stripe** | Paste a restricted key | — |
| **Linear** | Sign in, Paste a token | — |
| **Notion** | Sign in, Paste a token | — |
| **Sentry** | Paste an org auth token | — |
| **Discord** | Sign in, Paste a bot token | — |
| **Google Workspace** | Sign in, Paste a token | — |
| **Jira** | Sign in, Paste a token | — |
| **Cloudflare** | Paste a scoped API token | — |
| **Railway** | Paste a token | — |
| **Netlify** | Sign in, Paste a token | — |
| **HeyGen** | Paste an API key | — |
| **X** | Sign in, Paste a token | — |

Two of them have no Test connection: Linear and Railway are GraphQL over POST, so there is no call
that proves a token without making a request that does something. Their manifests say so by having
no `test_path`, and `perch connectors check` says it out loud.

### Adding one

Two ways, and neither is a code change:

- **In this repo**, for a connector you want everyone to have: add `connectors/<id>/manifest.yaml`,
  add the id to `connectors/src/index.ts`, and it ships with the build.
- **On your instance**, for one that is yours: point `PERCH_CONNECTORS_DIR` at a directory of
  `<id>/manifest.yaml` files. Perch reads it at boot, and a file there with the id of a built-in
  connector replaces it — which is how you correct one without waiting for a release. An unreadable
  file is logged and skipped; it never stops the instance coming up.

Either way, check it first:

```
perch connectors check ./connectors      # or a single manifest.yaml
```

This is the manifest harness. It parses the file, then exercises what it claims: a delivery signed
by its own webhook scheme must verify, the same delivery with one byte changed must not, and
somebody else's secret must not. It also says when a lane does not add up — an `mcp_oauth` lane with
no MCP server, a paste lane with no `test_path`, a provider that signs nothing at all. Errors mean
Perch would not work with the file and exit 1; warnings mean somebody should look. Every connector
in this repo is put through it in CI.

### What a manifest can say

Beyond the obvious fields:

| Field | For |
|---|---|
| `token_scheme: raw` | a provider that wants the token by itself rather than behind `Bearer` — Linear |
| `token_header` | a provider that wants it somewhere else entirely — HeyGen's `X-Api-Key` |
| `headers:` | headers every call needs — Notion refuses a request without `Notion-Version` |
| `oauth.authorize_params` | what a provider needs on its authorize URL beyond the standard parameters — Google's `access_type=offline`, Atlassian's `audience`. The flow's own parameters (`state`, `redirect_uri`, `code_challenge`, …) are ignored here, so a manifest cannot redirect a person's code somewhere else |
| `webhook.timestamp_prefix` | a provider whose timestamp rides inside the signature header — Stripe's `t=<ts>,v1=<hex>` |
| `webhook.id_header` | absent when the provider puts the delivery id in the body rather than a header — Slack, Stripe |
| `account_field` | where the test call's answer says who the connection speaks as; a dotted path, for a provider that wraps it — Cloudflare's `result.id`, X's `data.username` |

`api_base` and `mcp_url` can be overridden per connection, which is how a self-hosted Sentry or
GitLab uses the same manifest as the hosted one.

## Inbound webhooks

A provider can tell Perch when something happens. Make an endpoint in **Settings → Connections**, or
over REST:

```
POST /api/workspaces/{ws}/webhooks  {provider, name, channel_id, connection_id?}
→ {webhook: {…, url}, secret}
```

The answer carries the URL to paste into the provider and a secret **shown exactly once** — paste it
into the provider's own "secret" field. Perch verifies every delivery against it, with that
provider's scheme, taken from its manifest (ADR-0119):

| Provider | Header | Signed |
|---|---|---|
| GitHub | `X-Hub-Signature-256: sha256=<hex>` | the raw body |
| Vercel | `x-vercel-signature: <hex>` | the raw body |
| Clerk (Svix) | `svix-signature: v1,<base64>` | `<id>.<timestamp>.<body>`, within five minutes |
| Slack | `x-slack-signature: v0=<hex>` | `v0:<timestamp>:<body>`, within five minutes |
| Stripe | `stripe-signature: t=<ts>,v1=<hex>` | `<timestamp>.<body>`, within five minutes |
| Linear | `linear-signature: <hex>` | the raw body |
| Sentry | `sentry-hook-signature: <hex>` | the raw body |
| Jira | `x-hub-signature: sha256=<hex>` | the raw body |
| HeyGen | `signature: <hex>` | the raw body |
| X | `x-twitter-webhooks-signature: sha256=<base64>` | the raw body |
| Netlify | `x-webhook-signature: <JWS>` | an HS256 JWT carrying the body's SHA-256 |
| Discord | `x-signature-ed25519: <hex>` | `<timestamp><body>`, with Discord's own key, within five minutes |

**Discord is set up the other way round.** Ed25519 is asymmetric: Discord signs with a private key
nobody else has and publishes the public half on the application's page. So there is no Perch secret
to paste into Discord — you paste Discord's public key into Perch instead, and the answer has no
secret in it:

```
POST /api/workspaces/{ws}/webhooks  {provider: "discord", …, key: "<64 hex characters>"}
→ {webhook: {…, url}, secret: null}
```

A key sent for a provider Perch generates a secret for is refused rather than ignored, and so is a
missing one for Discord.

**Two providers send the secret back rather than signing.** Cloudflare puts it in `cf-webhook-auth`
and Google's push notifications put it in `X-Goog-Channel-Token`. Perch checks it in constant time,
so a delivery proves **who sent it and not what they sent** — `perch connectors check` warns about
exactly that, and it is why a Cloudflare endpoint's URL still deserves to be treated as a secret.

Three providers sign nothing at all: Notion verifies with a token you copy when the subscription is
made rather than with an HMAC, Railway posts its webhooks unsigned, and Supabase's webhooks are
Postgres triggers with whatever headers you give them. Their manifests say `webhook_signature: none`,
which Perch takes literally: **the endpoint's only protection is that its URL is unguessable**, so
treat it like a password, and prefer a connector that signs where you have the choice.

`POST /hooks/{provider}/{id}` is the only unauthenticated write in Perch: the signature is the
authentication. A delivery that is unsigned, signed with something else, signed over a different
body, or too old is a `403` and nothing is posted. An endpoint that is not there is a `404` whatever
it was signed with, and the wrong provider on the right id is the same answer.

A delivery that passes becomes a **card in the channel** the endpoint was wired to: what happened,
who did it, and a link. The same delivery twice is one card — a provider that never heard the `200`
sends again, and that is not news. A provider that sends no delivery id gets the same protection
from a hash of what it sent.

And a bot can be waiting for it. A `webhook` trigger fires on a delivery in a channel the bot is in:

```yaml
triggers:
  - on: webhook            # anything
  - on: webhook
    match: github          # only GitHub
  - on: webhook
    match: github:push     # only a push
```

The bot answers in the card's own thread, so what it says sits under what happened.
