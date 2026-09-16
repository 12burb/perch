---
"@perch/api": minor
---

A worktree per task. An item handed to an agent gets a git worktree of its own, on a branch named
`perch/key-123` beside the project checkout, so three agents can work one repository at once and
none of them sees another's half-finished edits. The isolation is git's rather than Perch's, and
the branch each agent is on is already the branch a pull request wants.

Closing an item gives the directory back and keeps the branch — a checkout is a place to work, not
the work. A project with no commit to branch from has no worktree to give, and the session works in
the project directory rather than refusing to start.

Sessions now report their `worktree`, `branch` and `work_item_id` over REST, so "which branch is
this agent on" stops being a question you answer by reading a diff.
