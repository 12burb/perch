---
"@perch/runner": patch
"@perch/events": patch
---

The runner passes everything a caller sends as a value, never an option: search queries and globs
go to ripgrep as option values, git is told where its options end before any ref and given `--`
before any path, and a branch name is checked against one rule shared with the protocol
(`BRANCH_NAME`) so names that read as options or refspecs are refused before git runs. A path is
kept inside the project on disk as well as as written (a link that points outside is not
followed, and a write never goes through a link), a read takes at most the cap from disk, and a
write lands whole or not at all (ADR-0164).
