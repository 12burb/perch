# @perch/engines

## 0.1.0

### Minor Changes

- 378589c: The ACP engine: every runner hosts the Agent Client Protocol adapter, so any registry agent
  (Gemini CLI, Codex, Claude Agent, goose, OpenCode, Qwen Code, Cline, or one you configure) runs
  Perch sessions in a project, with tool calls, diffs, permission prompts, modes, usage, and
  cancellation flowing through the session routes.
- 347ce60: Brains: bring your own models. Workspace settings gets a Brains section where you add an API key
  (OpenAI, Anthropic, Google, Groq, Mistral, xAI, OpenRouter) or an OpenAI-compatible endpoint
  (Ollama, LM Studio, vLLM, a proxy), keep it to yourself or share it with the workspace, and test it
  against the provider's own model list. Name a model as a brain, make one the default for code, and
  pick it when you start a session — the engine gets that brain's key and base URL in its
  environment, and nothing else does. A local Ollama is detected and added in one click.
  
  Starting a session now names the agent separately from the model: the new-session form's **Agent**
  field says which ACP agent or CLI runs it (empty means the runner's default), and the **Brain**
  picker says which model it runs on. `POST /api/.../sessions` and the runner's `session.create` both
  take an `agent` alongside `model` for this.
- fb30b24: Agents can use a connection's tools without ever holding its credential. Every connection whose
  provider has an MCP server is now one itself, at `/mcp/{connectionId}`: a session is handed that
  URL and a token Perch minted for it, and Perch attaches the provider's real credential on the way
  out. A grant's allow-list decides which tools a session may call — a refusal never reaches the
  provider — and every call is audited with the tool, the caller, and a hash of its arguments. A
  connection may override its provider's MCP URL for a self-hosted host, the way it already can for
  the REST API.
- eb5cdaa: Quick actions, a thinking level, and a background policy — all of them the project's own
  `.perch/project.json` deciding how Perch behaves.
  
  A project's `run` commands and its new `actions` become buttons above the composer and commands in
  ⌘K. A prompt action sends its text as a turn in its own mode and thinking level; a run action is
  typed into the project's terminal, where its output belongs. Firing one from ⌘K with no session open
  starts one.
  
  The composer's **Thinking** control sets a session's reasoning level (auto, low, medium, high) and
  sends it with every turn. The ACP adapter maps it onto the agent's own session config — ACP's
  `thought_level` option where an agent offers one — rather than asking the model nicely in prose.
  
  `background.unattended` names the tools that may run with nobody watching: Perch answers those
  permission prompts itself and says so in the transcript, while everything else still waits for a
  person. `background.autoSettle` ends a session once a round finishes with nothing outstanding, so a
  background run does not hold a runner open. Neither weakens the policy engine.
  
  And `.perch/project.json` can finally be re-read where the project is —
  `POST .../projects/{p}/config/reload` — instead of only at setup, which re-clones.
- cc5c90d: Sessions: the Engine interface with a fake engine and a runner-hosted bridge, the
  coding_sessions/session_events tables, and api routes to open a session in a project, send turns,
  answer permissions, cancel, and replay the transcript from a seq; every event fans out live on the
  session's WS topic.

### Patch Changes

- Updated dependencies [378589c]
- Updated dependencies [347ce60]
- Updated dependencies [3318f0e]
- Updated dependencies [b144df4]
- Updated dependencies [a837eea]
- Updated dependencies [a451282]
- Updated dependencies [de84546]
- Updated dependencies [fb30b24]
- Updated dependencies [5f61320]
- Updated dependencies [c4e921c]
- Updated dependencies [f3aefb9]
- Updated dependencies [eb5cdaa]
- Updated dependencies [ea81bde]
- Updated dependencies [0d33a89]
- Updated dependencies [cc5c90d]
- Updated dependencies [a438fc6]
- Updated dependencies [f0ff645]
  - @perch/events@0.1.0

## 0.0.1

### Patch Changes

- e05fb7a: Resolve and pin every dependency named in the spec (docs/dependencies.md), with ADR-0019..0028 for the non-obvious picks; commit the lockfile.
