# The MCP gateway: tools without tokens

An agent that can read your issues needs to reach your issue tracker. It does not need your
credential. The gateway is how Perch keeps those two apart (spec §3.5, §7.5; task 1.17,
ADR-0083).

## What it is

Every connection that points at a provider with an MCP server is itself an MCP server, at
`/mcp/{connectionId}`. Perch is a client on one side and a server on the other:

```
agent ── Perch's token ──▶ /mcp/{connection} ── the connection's token ──▶ the provider
```

The agent holds a token Perch minted for its session. The provider's own credential is attached
here, on the way out, and exists in one process for the length of one call. Nothing in between —
the runner, the agent, the transcript, a log line — ever holds it.

## What a session gets

When a session is created it is granted the connections **its own owner** already has: your agent
acting for you is on-behalf-of by definition. Perch mints a twelve-hour token for that session and
hands the runner a list of `{name, url, token}`, which the runner gives the agent as MCP server
configuration. A workspace connection is not granted automatically — spec §3.5 wants a shared
identity granted explicitly — so it stays invisible to sessions until the grants UI arrives with
task 2.14.

If a provider is unreachable, or a session has no connections, the session simply starts without
tools. A connection outage is not a broken turn.

## Allow-lists

A grant may name the tools a session may use. With no list, the session sees everything the
provider offers; with one, `tools/list` shows only those and a call to anything else is refused
before the provider is contacted at all.

## The audit

Every call writes a `tools.called` event — the caller, the connection, the tool, a SHA-256 of the
arguments, and the outcome (`ok`, `error`, or `denied`) — which the audit subscriber turns into a
row in the workspace audit log. The *hash* of the arguments, never the arguments: a tool call can
carry anything, and an audit log the whole workspace can read is the wrong place for it.

Workspace settings → Audit, or `GET /api/workspaces/{ws}/audit?action=tools.called`.

## A self-hosted provider

A connector's manifest names the public MCP server for its provider. An enterprise or self-hosted
install runs its own, so a connection can override it with `mcp_url` when it is created, the same
way `api_base` overrides where REST calls go.

## Perch itself, at `/mcp/perch`

The other direction. Everywhere above, Perch is the proxy; here it is the provider — an agent
running somewhere else reads the chat, searches it, answers in it, and opens a coding session,
all over MCP (spec §7.5; task 3.12).

Point any MCP client at `https://<your perch>/mcp/perch` with an api token from
**Settings → Security** as its bearer. A token made for one workspace (`workspace_id`) is bound
to a membership: it can only be made for a workspace you are in, it stops working here when you
leave, and on the REST API it answers for that workspace alone (ADR-0162):

```json
{
  "mcpServers": {
    "perch": {
      "url": "https://perch.example.com/mcp/perch",
      "headers": { "Authorization": "Bearer pat_…" }
    }
  }
}
```

| Tool | Does | Needs |
|---|---|---|
| `channels.list` | The channels you can see, with their ids | `chat:read` |
| `messages.search` | Search the chat you can see | `chat:read` |
| `messages.post` | Say something, as you | `chat:write` |
| `sessions.open` | Open a coding session on a project | `sessions:open` |
| `connections.call` | Call a tool on a connection, through the gateway above | `tools:call` |

**The token's scopes are the grant.** A tool a token has no scope for is not refused at the end of
an argument round-trip — it is not in `tools/list` at all, so an agent plans with the doors it
actually has. `read` and `write` carry the narrower scopes, and `admin` carries everything, the
same way they do over REST.

A token made for one workspace acts in that one. A token made for none acts in every workspace you
are a member of, which is why `channels.list` is the sensible first call: it answers with ids the
other tools take. Everything goes through the same service the REST handler for it goes through,
so a channel you cannot see is as invisible here as it is there, and a message you post is a
message from you — not from a bot, not from Perch.

A tool that will not run says so in its result rather than failing the call, because an agent can
read a reason and try something else. `work.create` and `work.update` are the two §7.5 names not
here yet; they arrive with work items themselves (task 3.13).

## A server your project ships (task 3.24)

A repository often knows things no provider does: the schema, the fixtures, the deploy. Perch runs
those tools where the project is rather than hosting them:

```
POST /api/workspaces/{ws}/mcp-servers
  {name: "project-tools", project_id, command: "bun", args: ["tools/mcp.ts"]}
```

The runner spawns that command beside the checkout when somebody calls it (`mcp.spawn`, spec §7.6),
and the api speaks MCP down the stream it answers with — MCP's stdio framing and a runner stream are
the same shape. Nothing is listening on a port, and the process lives only as long as the call.

From the outside it is the same server as any other: `/mcp/{id}` lists and calls it, and a bot
attaches it by naming it in its spec —

```yaml
mcp:
  - connection: project-tools   # the row's name, or its id
```

— which becomes `mcp__project-tools__<tool>` in the bot's tool list, like a connection's.

Two things are different, and both follow from there being **no credential**: there is no grant to
write, because a grant exists to lend somebody else's token; and the gate is the workspace the row
belongs to, the bot spec that names it, and the runner's own policy on what may be run at all — a
command nobody may run by hand is not one somebody may run by writing a row (ADR-0142).

A workspace admin writes the row. The command runs on the workspace's own machines, which is
exactly as much trust as `exec` already needs.

## Not here yet

Tools marked `requires_permission` return pending with a card in the thread and an inbox item for
bots that attach a connection (see [Tools from an MCP server](bots.md#tools-from-an-mcp-server));
sessions still call straight through.

Still to come: rate limits, virtual keys (`pk_…`) as a third way in beside sessions and api tokens,
and the grants UI.
