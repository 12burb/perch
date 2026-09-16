---
"@perch/runner": patch
"@perch/api": patch
---

Three fixes the Phase 3 end-to-end run found. A session in a worktree now runs in the directory
`worktree.create` made rather than in a path built by joining the branch name on, so an agent given
its own checkout no longer fails with "worktree … does not exist" — every branch with a slash in
it, which is all of them. Preflight no longer fails a page over the favicon the browser asked for
and nobody wrote. And a race refuses two entries from the same engine, which would have been two
entrants in one worktree, instead of failing halfway through starting them.
