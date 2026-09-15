---
"@perch/db": patch
"@perch/api": patch
---

Shutting down no longer depends on luck. A closing database now waits for the queries it already
started and refuses anything that arrives afterwards, and the runner channel finishes marking its
runners offline before the database goes — so a restart finds them offline rather than online, and a
shutdown cannot leave PGlite spinning at 100% CPU with a write in flight.

With that fixed, a shutdown also waits for a bot's in-flight run to finish, instead of abandoning it
with its run row stuck on "running".
