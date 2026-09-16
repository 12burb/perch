---
"@perch/api": minor
"@perch/db": minor
"@perch/ui": patch
"@perch/web": minor
---

Agent bots. A bot with an `engine` and `projects` in its spec no longer answers from a model: a
mention opens a coding session on that project and posts a session card in the thread, with a link
straight into Code mode. Permissions the engine asks for arrive as Approve / Deny cards in the same
thread, and answering one answers the engine.

When the session finishes, what the agent left behind is put on a branch of its own, read for
secrets, committed, pushed and opened as a pull request — the thread gets a diff card with what
changed, Open in IDE, and the pull request. `pullRequest: false` leaves the work in the session, and
a project with no repository, no connection, or a change with a credential in it stops there and
says so rather than failing quietly.
