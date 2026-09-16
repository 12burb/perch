---
"@perch/api": minor
"@perch/bots": minor
"@perch/ui": patch
"@perch/web": minor
---

The Nest. A roster of agents you can install as a team — Birbus, who runs it, and four specialists:
Dawn (code), Julius (finding things out), Paige (writing) and Kimi (what the data says). Workspace
settings → Bots → The Nest, or `POST /api/workspaces/{ws}/nest`.

Each joins through one of two doors. A Bot API agent becomes an external bot with a token shown once
on the install, and runs wherever it already runs; a Hermes agent becomes an agent bot on the
`hermes` engine, which Perch runs on a project's runner. What comes out either way is ordinary bots:
edit them, install them in channels, delete them.

Installing one grants it nothing. Kimi expects a Supabase connection and says so, but an admin still
has to grant it on the Connections page — until then the agent is refused.
