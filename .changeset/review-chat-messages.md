---
"@perch/api": patch
"@perch/web": patch
"@perch/api-client": patch
---

Messages hold up under concurrency and keep to what the caller can see (ADR-0174). The Later list
(`GET /api/workspaces/{ws}/bookmarks`) lists only that workspace's messages in channels you can open
now, as a page (`limit`, `before`). A deleted message keeps no edit history and cannot be written
back into by a streaming reply or a card; two deletes of one reply take one off its thread's count.
Two presses on one interactive block are one answer and one 409; two quick edits keep every version;
an edit counts only the mentions it adds. In an archived channel nobody edits and only a moderator
deletes. The cards Perch posts about its own work (session, diff, race, deploy, queue, background,
preflight, plan, webhook) are refused from people and Bot API bots, a race card draws its race from
the api before offering Pick, and a card's "Open" link must stay on this origin. A channel's
`project_id` and a webhook's `connection_id` outside the workspace are 404 instead of a 500, a
36-character non-uuid unfurl reference is no card instead of a 500, and a stray `%` in a reaction's
path is no longer a 500.
