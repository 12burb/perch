---
"@perch/api": minor
"@perch/connect": minor
"@perch/engines": minor
"@perch/events": minor
"@perch/runner": minor
---

Agents can use a connection's tools without ever holding its credential. Every connection whose
provider has an MCP server is now one itself, at `/mcp/{connectionId}`: a session is handed that
URL and a token Perch minted for it, and Perch attaches the provider's real credential on the way
out. A grant's allow-list decides which tools a session may call — a refusal never reaches the
provider — and every call is audited with the tool, the caller, and a hash of its arguments. A
connection may override its provider's MCP URL for a self-hosted host, the way it already can for
the REST API.
