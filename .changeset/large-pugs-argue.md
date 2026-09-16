---
"@perch/api": minor
"@perch/runner": minor
"@perch/connect": minor
---

Runner-local MCP servers. A project can ship its own tools — a command in the repository — and
Perch runs them where the project is: the runner spawns the process, the api speaks MCP down the
stream it answers with, and `/mcp/{id}` looks exactly like a connection's server. A bot attaches
one by naming it in its spec. No port, no token, no vault entry: the gate is the workspace, the
spec, and the runner's own policy on the command.
