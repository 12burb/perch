---
"@perch/runner": patch
---

The cli-harness waits for a CLI's output to end, not just for its process to exit. A `codex exec
--json` turn whose last JSONL lines were still in the pipe when the process went became a bare
`done` with no tools, no text and no usage — reliably enough on Windows to fail CI.
