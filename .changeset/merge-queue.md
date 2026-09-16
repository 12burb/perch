---
"@perch/db": minor
"@perch/api": minor
"@perch/events": minor
"@perch/runner": minor
"@perch/web": minor
"@perch/ui": patch
---

A merge queue. Branches land one at a time, each rebased onto what landed before it and each held
to the project's own checks — whatever `.perch/project.json` calls `check`, `test`, `ci` or
`verify`. Three agents can now finish three branches at once and have them arrive in order rather
than in a heap.

A branch that will not rebase, or whose checks go red, does not stop the queue: it is marked with
git's own words or the tail of the command's output, its work item goes to Needs you, and the
session that wrote it is asked to fix what it broke. The next branch lands meanwhile.

The thread gets one queue card per branch, rewritten in place as it moves from waiting to landing
to landed — so a thread reads as a queue rather than four notifications.

Under it: `git.merge` on the runner does the rebase and the fast-forward as one operation, because
two of those racing is what a queue exists to prevent, and `worktree.create` now answers with where
a branch already is rather than refusing to make a second one.
