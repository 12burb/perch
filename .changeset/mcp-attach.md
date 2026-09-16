---
"@perch/api": minor
"@perch/bots": minor
"@perch/db": minor
"@perch/events": minor
---

Bots can use an MCP server. A bot's spec names connections under `mcp:`, the grant decides which of
their tools it actually gets, and each one arrives in the turn as `mcp__<provider>__<tool>` with its
answer wrapped as untrusted. The call goes out through the MCP gateway on the connection's own
token — the credential never reaches the bot's context.

A grant can mark tools `requires_permission`. Calling one of those parks the call instead of running
it: an Approve / Deny card appears in the thread and an item in the inbox of whoever set the bot
running. Approving runs it then, re-checking the grant first, and posts the result in the thread.
`GET /api/workspaces/{ws}/bot-tool-calls` lists what is waiting.
