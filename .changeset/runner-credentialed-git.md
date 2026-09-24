---
"@perch/runner": patch
---

A clone or push holding a connection token or the deploy key no longer runs the repository's hooks,
no longer asks credential helpers the repository configured, and offers the token to the remote's
own host only, over https (or ssh for the deploy key). A push whose effective URL leads somewhere
other than where the project was cloned from, or whose repository config sets its own proxy or CA,
is refused before git runs.
