---
"@perch/api": patch
---

The merge queue holds every branch to the project's checks: a branch the checks have nowhere to run
for (checked out in the project directory, or one git will not give a worktree) fails instead of
landing unchecked, a branch name that does not exist fails as `no such branch` instead of being made
from the base and reported landed, and each entry runs as the person who queued it. The queue picks
itself up after a restart, and a landing the previous process never finished is released at once.

A restart no longer leaves work stuck: coding sessions and bot replies that were mid-flight are
marked as errors ("interrupted by a restart"), so the board, races and cards move on, and only the
api does this — the supervisor and `backup` no longer fail the api's in-progress project setups. On
shutdown the api stops taking requests before anything else goes.

Picking a race winner or closing a work item stops an agent still working before its worktree is
removed. Two starts on one work item at once open one session and answer the other 409, and two
work items or queue entries created at the same moment get the next number instead of a 500.
