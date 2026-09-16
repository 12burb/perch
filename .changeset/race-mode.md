---
"@perch/api": minor
"@perch/db": minor
"@perch/events": minor
"@perch/ui": patch
"@perch/web": minor
---

Race mode. Ask two to eight engines the same question at once, each in a worktree of its own, and
get back a comparison rather than an answer: what each one changed, what it cost, and what the
project's checks made of it. Press **Pick** on the row you want, or let the checks decide — they
take the cheapest entrant that passes, smallest diff breaking a tie. The winner's branch lands
through the merge queue like any other; every other entrant gives its directory back and keeps its
branch, so what the engine that lost was thinking is still there to read.

Sessions that nobody opened by hand — a work item's, a race entrant's — now carry `unattended` and
settle when their round goes quiet, instead of holding a runner open for a next turn that is never
coming.
