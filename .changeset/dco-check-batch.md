---
"@perch/scripts": patch
---

The DCO check counts a commit's parents with one `git cat-file --batch` for the whole range
instead of one process per commit, so checking a repository's own history takes milliseconds
rather than seconds, on a loaded machine too.
