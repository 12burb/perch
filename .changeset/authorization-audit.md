---
"@perch/api": patch
---

Authorization fixes from the code audit: revoking a grant is scoped to the connection in the path;
a Bot API token is minted, listed and revoked by the bot's owner or an admin, not any member; a
grant on a workspace-owned connection needs `connections.admin`, like disconnecting it; a work
item's cycle and module must belong to its project; deploy, screenshot and preflight cards go only
into channels the caller can see; somebody outside the workspace cannot be added to its channels;
an MCP OAuth connection sends its access token upstream, never the stored pair with the refresh
token; and a tool a grant marks `requires_permission` is refused to bots outside Perch, which have
nobody to ask.
