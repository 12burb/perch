---
"@perch/cli": patch
"@perch/api": patch
"@perch/runner": patch
"@perch/events": patch
"@perch/db": patch
---

Laptop mode (task 0.14): `perch dev` runs the api, the web app, and an in-process runner on PGlite under
`~/.perch`; `perch doctor` checks the machine and the data directory; `perch backup` and `perch restore`
round-trip the PGlite data, files, and master key as a backup directory. `RunnerLink` in `@perch/events`
and the api's runner registry (`GET /api/health` now reports `checks.runners` and `mode`) are the seam
the hosted and local runners plug into next.
