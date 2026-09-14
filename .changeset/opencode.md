---
"@perch/runner": minor
"@perch/api": minor
---

The OpenCode engine: runners start `opencode serve` per project (the pinned binary ships in the
runner image) and drive it through the SDK, so a session runs OpenCode's build or plan agent with
tool calls, the edit tools' diffs, permission prompts, usage, and cancellation flowing through the
session routes.
