---
"@perch/api": minor
"@perch/bots": minor
"@perch/db": minor
"@perch/ui": patch
"@perch/web": minor
---

Orchestrators can split a job. A bot with `orchestrator: true` and the `fan_out` tool takes a whole
plan in one call — who does what, and whether to wait for all of them, the first, or a quorum — and
the thread gets a plan card showing each specialist, what they were asked, and what they may spend,
rewritten in place as answers land.

What is left of the thread's budget is divided evenly among the bots actually tagged, and each share
is that bot's alone: the first to run can no longer spend what the others were promised. Every reply
comes back to the orchestrator at once, wrapped as untrusted, for it to fold into one answer.

A bot without the flag that calls `fan_out` is told so, and nobody is tagged.
