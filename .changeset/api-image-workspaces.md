---
"@perch/api": patch
---

The api image builds again: the `connectors` and `templates` workspaces are copied into the build stage
(a frozen `bun install` needs every workspace in the lockfile), and a `.dockerignore` keeps installs,
builds, and `.env` files out of the build context.
