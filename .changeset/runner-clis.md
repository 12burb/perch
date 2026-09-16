---
"@perch/runner": minor
---

The four official agent CLIs now ship inside the runner image, pinned: Codex
(`@openai/codex`), Claude Code (`@anthropic-ai/claude-code`), Gemini CLI (`@google/gemini-cli`) and
OpenCode (`opencode-ai`), plus the `codex-acp` and `claude-agent-acp` bridges. A session starts on
any of them without fetching anything first.

One file pins them — `deploy/agents.json` — and the image installs from it and then carries it at
`/opt/perch/agents.json`, so a runner reports the four and their versions in
`capabilities.versions` rather than guessing. A runner with no manifest (a laptop joined with
`perch runner connect`) asks each CLI itself and reports only what is really there.

CI builds the image's `agents` layer on every push and checks that each CLI reports the version the
manifest pins.
