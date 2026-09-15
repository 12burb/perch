---
"@perch/web": patch
"@perch/runner": patch
---

Clone a repository through a service you have already connected: pick "A connected service" under
Authentication in Code mode and Perch mints a token for that one clone. Connections can also point
at a service you host yourself — a GitHub Enterprise Server, say — with the new API base field.

A runner can be told about an `opencode serve` that is already running (`PERCH_OPENCODE_URL`)
instead of starting one per project.

Phase 1's exit criterion now runs on every push as one Playwright spec, four times over: clone via
GitHub, ask for a change, watch it in Preview from a phone, review the diff, commit, open a pull
request — on a key, on Ollama, through OpenCode, and through ACP.
