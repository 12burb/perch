---
"@perch/runner": patch
---

The runner's connect token (and, in laptop mode, the master key and session secret) no longer
reaches anything the runner starts. Shells and sessions already had every `PERCH_*` variable
blanked; now `exec`, a project's dev server and `postCreateCommand`, MCP servers, git (and so a
repository's hooks), agent version probes, ripgrep and the screenshot browser start from the same
blanked environment, and a test fails on any process the runner starts without it.
