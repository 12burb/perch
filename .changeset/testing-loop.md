---
"@perch/api": minor
"@perch/db": minor
"@perch/events": minor
"@perch/runner": minor
---

The testing loop. Put `background.testLoop` in `.perch/project.json` and the project's own tests run
after any round that wrote something — in the session's worktree, or its checkout — and a failure
goes straight back to the agent as the next turn, with the command and what it said. It gets two
tries by default (five at most); after that the session stops at **needs you** with what still
fails, where the inbox and the background card already look.

A round that only answered a question is not tested, a round that errored is not told off for it,
and leaving `testLoop` out leaves everything as it was.
