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

## Not here yet

Tools marked `requires_permission` return pending with a card in the thread and an inbox item for
bots that attach a connection (see [Tools from an MCP server](bots.md#tools-from-an-mcp-server));
sessions still call straight through.

Still to come: runner-local stdio servers exposed through the same shape, rate limits, Perch's own
`/mcp/perch` server (channels, messages, work, sessions), and the grants UI.
