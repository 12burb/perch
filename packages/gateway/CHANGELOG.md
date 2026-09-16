# @perch/gateway

## 0.1.0

### Minor Changes

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
- f39b87d: Bots that answer. A workspace can now make a bot, give it a persona and a brain, put it in a channel
  and have it reply when it is named — streaming into its message the way a person's typing fills in,
  always in the thread it was asked in. Triggers cover mentions, DMs, keywords, a bot's own arrival, a
  reaction and a cron schedule; the native tools (web search, fetching a page, reading and posting in
  channels, remembering and recalling, thread facts) are each the bot's own, and everything they bring
  back is wrapped as untrusted so a webpage cannot tell a bot what to do. Every turn is on a ledger
  with its tokens and cost, and a bot over its daily budget or its rate limit says so instead of going
  quiet.
- 8d7d282: Repo intelligence: Perch reads a project once and remembers it. **Index now** in Code mode's new
  Codebase drawer walks the repository, cuts each file into symbol, window and Markdown-section chunks,
  and writes them with a Postgres full-text index — and, when the workspace names a brain whose default
  is `embedding`, with vectors as well. Typing `@codebase` in a session hands the agent the places your
  question is about, each citing its file and lines, while the transcript keeps what you actually
  typed. The same index answers in the panel, and in the new Code lane of the search box across every
  project you can see, with each hit opening the file at the line. **Draft AGENTS.md** writes an
  operating manual from what the repository shows and can save it into the project.
  
  Embeddings stay optional on purpose: a Perch with no model credentials still has a working codebase
  index and `@codebase` still cites the right file. A brain becomes the one Perch embeds with from the
  new **Default for** control in Brains, which now names chat, code, and embedding rather than code
  alone.

## 0.0.1

### Patch Changes

- e05fb7a: Resolve and pin every dependency named in the spec (docs/dependencies.md), with ADR-0019..0028 for the non-obvious picks; commit the lockfile.
