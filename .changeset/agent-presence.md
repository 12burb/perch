---
"@perch/api": minor
"@perch/events": minor
"@perch/ui": patch
"@perch/web": minor
---

Agent presence. Bots mode's sidebar now opens on **Working now**: every coding session and every bot
run in the workspace that is actually going, oldest first, each saying what it is doing and what it
has cost, and each linking into the thing itself. It is live — a session changing status, a run
starting or finishing, a stop — with a poller behind it.

Beside every row is **Stop**, and it is one button whatever the row is: a session's round is
cancelled, and a bot's model call is aborted so the run ends saying a person stopped it rather than
sitting there. Stopping something that just finished answers "nothing to stop" rather than an error.
