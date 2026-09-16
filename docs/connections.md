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

### Setting up a GitHub App

GitHub's remote MCP has no dynamic client registration, so an app is the way to give Perch a real
identity there. The Connections card prefills the two URLs GitHub asks for:

- **Callback URL** — `<your Perch>/api/connect/callback/github`
- **Webhook URL** — `<your Perch>/hooks/github/<workspace>`

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

Then it is an ordinary OAuth 2.1 round-trip: PKCE with `S256`, and a `resource` parameter naming
the MCP server the token is for, so a token minted for one server cannot be replayed at another
(RFC 8707). The access token and its refresh token go into the vault; the card shows the lane the
connection was made on and nothing else.

**MCP server** is the same escape hatch **API base** is: leave it empty for the provider's public
server, fill it in for one you host yourself.

### Using your own app

**Use my own app** appears on both sign-in lanes. Register an OAuth app with the provider, give it
the callback URL shown in the card, and paste the client id — and the secret, if the provider issued
one, which is sealed in the vault like any other credential. Perch prefers that app over registering
one itself, which is what you want when the provider's dashboard is where your organisation's
audit trail lives.

## Who may use a connection

Every row has **Who may use it**. A connection reaches nothing on its own; something has to be
granted it — a bot today, an automation later.

One rule governs the interesting case. A connection that belongs to **you** may be granted to a bot
**the whole workspace can talk to** only *on your behalf*: the grant carries that flag, and the
gateway refuses the call when the person who set the bot running is not you. Anything else is
refused outright, with a 403 that says so. A bot that is yours alone, or a connection the workspace
owns, has no such restriction — this is the rule that stops "ask the shared bot to do it" from
becoming a way to borrow somebody's login (spec §3.5, AGENTS.md §1.6).

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

## Adding a connector

A connector is a directory under `connectors/` with a `manifest.yaml`: the lanes it offers, its API
base, the token prefixes a paste should have, the call that proves a connection works, its MCP
server, and its OAuth endpoints. Add the directory, add its id to `connectors/src/index.ts`, and the
service appears in the card. See `connectors/github/manifest.yaml`.

Four ship today:

| Connector | Lanes | MCP server |
|---|---|---|
| **GitHub** | Install an app, Sign in, Paste a token | `https://api.githubcopilot.com/mcp/` |
| **Vercel** | Sign in through its MCP server, Paste a token | `https://mcp.vercel.com` |
| **Supabase** | Sign in through its MCP server, Paste a token | `https://mcp.supabase.com/mcp` |
| **Clerk** | Sign in through its MCP server, Paste a token | `https://mcp.clerk.com/mcp` |

- **Give an agent its tools.** A connection whose provider has an MCP server becomes one itself, at
  `/mcp/{connectionId}`. Sessions you start reach it with a token of Perch's, never with yours —
  see [the MCP gateway](./mcp-gateway.md).

## Not here yet

A refresh job for tokens that expire: today a connection whose access token has run out is marked
**Not accepted** and reconnected by hand, even where the provider issued a refresh token (Perch
keeps it). The Deploy button and the schema browser that these connectors are for arrive with task
2.15.

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
