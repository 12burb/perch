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
| **Sign in** | OAuth 2.1 with PKCE, through an app this instance registered with the provider. | Your own account, when the provider has an OAuth app you can register. |
| **Paste a token** | A personal access token or API key. Always available, whatever else a service offers. | The quickest path, and the fallback when nothing else fits. |

A pasted token is checked against the provider before it is kept, so a wrong paste is caught here
rather than at the first clone. A paste from the wrong field — an OpenAI key into GitHub, say — is
refused on its shape before Perch asks anyone anything.

### Setting up a GitHub App

GitHub's remote MCP has no dynamic client registration, so an app is the way to give Perch a real
identity there. The Connections card prefills the two URLs GitHub asks for:

- **Callback URL** — `<your Perch>/api/connect/callback/github`
- **Webhook URL** — `<your Perch>/hooks/github/<workspace>`

Create the app on GitHub with those, install it on the repositories you want, then paste its **App
ID**, its **private key**, and the **installation ID** into the card. Perch stores only the private
key; every token it uses is minted from that key for one call and expires within the hour.

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

## Adding a connector

A connector is a directory under `connectors/` with a `manifest.yaml`: the lanes it offers, its API
base, the token prefixes a paste should have, the call that proves a connection works, and its
OAuth endpoints. Add the directory, add its id to `connectors/src/index.ts`, and the service appears
in the card. See `connectors/github/manifest.yaml`.

## Not here yet

MCP OAuth with dynamic client registration, refresh jobs for tokens that expire, the grants UI, and
the connectors beyond GitHub (Vercel, Supabase, Clerk) arrive with task 2.14; the MCP gateway that
exposes a connection's tools to an agent is task 1.17.
