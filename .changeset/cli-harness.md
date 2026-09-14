---
"@perch/runner": minor
"@perch/api": minor
---

The cli-harness engine, behind the `cli_harness` feature flag (off by default): on a local runner
or in laptop mode, a session can run Codex (`codex exec --json`) or Claude Code
(`claude -p --output-format stream-json`) under the person's own login, with the CLIs' streams as
the transcript and their own sessions resumed turn after turn. Feature flags arrive with it:
`PERCH_FLAGS` and the `flags` instance setting.
