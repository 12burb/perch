---
"@perch/api": patch
"@perch/bus": patch
"@perch/jobs": patch
"@perch/db": patch
---

Lifecycle fixes from the code audit (ADR-0165): two turns arriving together start one round, not
two; a round that fails before it starts ends the session's "running" state instead of leaving it;
a merge-queue landing the api never finished is failed and the queue moves on; a race is decided
once even when its entrants finish together; the job worker's sleep leaks no abort listener; the
event bus keeps a bounded number of replay buffers; projects a restart caught mid-setup are marked
error at boot; a runner container just started is not idle-stopped on a stale last-seen time; a
database backup walks each table in primary-key order; and `%` or `_` in a file search mean those
characters.
