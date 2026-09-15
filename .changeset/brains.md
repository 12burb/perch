---
"@perch/gateway": minor
"@perch/runner": minor
"@perch/engines": minor
"@perch/events": minor
"@perch/api": minor
"@perch/web": minor
"@perch/db": minor
"@perch/policy": minor
"@perch/ui": minor
---

Brains: bring your own models. Workspace settings gets a Brains section where you add an API key
(OpenAI, Anthropic, Google, Groq, Mistral, xAI, OpenRouter) or an OpenAI-compatible endpoint
(Ollama, LM Studio, vLLM, a proxy), keep it to yourself or share it with the workspace, and test it
against the provider's own model list. Name a model as a brain, make one the default for code, and
pick it when you start a session — the engine gets that brain's key and base URL in its
environment, and nothing else does. A local Ollama is detected and added in one click.

Starting a session now names the agent separately from the model: the new-session form's **Agent**
field says which ACP agent or CLI runs it (empty means the runner's default), and the **Brain**
picker says which model it runs on. `POST /api/.../sessions` and the runner's `session.create` both
take an `agent` alongside `model` for this.
