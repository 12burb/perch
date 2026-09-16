---
"@perch/web": patch
---

A project that finished setting up no longer waits for a reload to say so. Code's project list
refetches while anything is being set up, so a missed socket event — a reconnect, a subscribe that
landed a moment late — no longer leaves "Setting up" on a project that is ready.
