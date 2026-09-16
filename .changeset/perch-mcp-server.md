---
"@perch/api": minor
"@perch/web": minor
"@perch/ui": patch
---

Perch is an MCP server. Point any MCP client at `https://<your perch>/mcp/perch` with an api token
as its bearer, and an agent running anywhere — on your laptop, in a cron job, inside an IDE — can
list the channels it can see, search the chat, post as you, open a coding session on a project,
and call a tool on one of your connections. The gateway has always put other people's tools in
front of Perch; this is Perch's own.

The token's scopes are what it may do, and a tool it has no scope for is not in `tools/list` at
all, so an agent plans with the doors it actually has. **Settings → Security** now offers every
scope rather than just read/write/admin, shows the MCP URL beside them, and starts a new token at
read alone instead of read and write — a token should begin with the least it can.

A tool that will not run answers with the reason rather than failing the call, because an agent
can read a reason and try something else. `work.create` and `work.update` arrive with work items
themselves.
