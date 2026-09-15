---
"@perch/api": minor
"@perch/web": minor
"@perch/policy": minor
"@perch/runner": minor
"@perch/events": minor
"@perch/ui": minor
---

A project's environment: the variables its sessions, terminals and dev servers run with, encrypted
at rest and write-only — a value goes in once, and the api only ever answers with the keys. The
values are put in front of an agent's process and a terminal's shell, and taken out of everything
written down: an agent that prints `$DATABASE_URL` leaves `[redacted: DATABASE_URL]` in the
transcript, so the record people read and the transcript a model is shown later carry the name
rather than the secret.
