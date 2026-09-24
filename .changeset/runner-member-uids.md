---
"@perch/runner": patch
"@perch/cli": patch
"@perch/api": patch
---

A hosted runner no longer runs everything as one user. The runner agent runs as root and every
process it starts runs as the member it is for — a uid of their own, stable across restarts, with a
home only they can read — or, for version probes and the screenshot browser, as an unprivileged
shared uid; git holding a connection token or deploy key runs as an account of its own. What the
runner reads and writes for a member it does with that member's file permissions. Projects stay
shared: group-writable, setgid, one checkout per workspace. No child can read the runner's connect
token out of `/proc` any more; a local runner (`perch runner connect`) makes itself non-dumpable
on Linux for the same reason. The nightly project backup leaves out, and logs, files a member made
private instead of failing.
