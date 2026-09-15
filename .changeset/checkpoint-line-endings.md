---
"@perch/runner": patch
---

Checkpoints, restores, and rejected hunks no longer rewrite a file's line endings on Windows,
where git converts LF to CRLF by default. The snapshot lane now runs with that conversion off, so
what a checkpoint captured is what a restore puts back.
