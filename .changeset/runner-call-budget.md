---
"@perch/api": patch
"@perch/events": patch
---

A runner call waits as long as its work: `RunnerLink.call` takes an optional `timeoutMs`, and the
api sizes it from the call's own budget (an `exec`'s `timeout`, a project setup's clone and
postCreateCommand allowance) instead of aborting every long call at the link's 30 s default while
the runner kept working. A runner that reconnects while its old socket lingers keeps the new
registration and stays online; the stream hub fails what was still waiting at shutdown instead of
hanging it (ADR-0163).
