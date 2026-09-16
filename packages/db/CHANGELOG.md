# @perch/db

## 0.1.0

### Minor Changes

- 378589c: The ACP engine: every runner hosts the Agent Client Protocol adapter, so any registry agent
  (Gemini CLI, Codex, Claude Agent, goose, OpenCode, Qwen Code, Cline, or one you configure) runs
  Perch sessions in a project, with tool calls, diffs, permission prompts, modes, usage, and
  cancellation flowing through the session routes.
- 9246f90: The Bot API: a bot can now live outside Perch. Mint a token on the bot's card in the Forge — you
  choose what it may do, and the value is shown once — and a program holding it posts, reads the
  channels the bot was put in, uploads files, calls a connection's tools through the MCP gateway, and
  opens agent sessions, over Slack-shaped endpoints under `/api/bot/`. Socket mode at
  `/api/bot/socket` tells it when somebody says its name, reacts, puts it in a channel, presses one of
  its buttons, or when a session finishes. Sixty calls a minute per bot, with `Retry-After` on the
  sixty-first.
  
  `@perch/bot-sdk` is the client to write that program against: `bot.chat.postMessage(…)`,
  `bot.on("app_mention", …)`, no dependencies, published to npm as `perch-bot-sdk`.
- ea3b91b: Bots can work together. One bot tags another in a thread — to ask, to fan a question out to several,
  or to hand the task over — and the answers land in the same thread, attributed. What keeps that from
  running away is on rails: six hops per conversation, no bot answering itself, a pair that keeps
  bouncing stopped on the third leg, and a budget for the whole thread that the bot which started it
  sets. When the rails stop a chain the thread pauses and a card asks a person whether to carry on, and
  anybody can type `/stop` or `/resume` themselves. The thread's header says who is in it, how far it
  went, and what it cost.
- ed9f649: Chat with a bot on your own. Home's sidebar now lists the bots the workspace can talk to, and
  picking one opens the room you share with it. Every chat in that room is its own conversation:
  "New chat" starts the bot over with nothing behind it, and the chats you have already had stay in
  the picker beside the button. A bot whose maker allows it puts a brain picker in the header, so
  your chat can run on a different model from the one it uses in channels — the choice is kept for
  that room alone.
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
- 9c29082: Connections, part one: the core of connecting a service. A connector is a manifest.yaml describing
  one provider — its lanes, its API base, the scopes to ask for — and GitHub's ships with Perch. You
  can paste a personal access token or install a GitHub App, and either way the secret goes into the
  vault and never comes back out to a caller: a connection shows the account it speaks as and a hint
  like `gi…wxyz`, nothing more. An App connection stores only the private key and mints a fresh
  installation token for each call. Cloning a project can now run on a connection, with the token
  minted for that one clone. The instance publishes its OAuth client metadata document at
  `/.well-known/oauth-client-metadata.json`, whose URL is the client_id it declares.
- 3318f0e: Ship from the IDE, and look at your database while you are there. The drawer has two new tabs.
  **Deploy** builds the project's branch through a Vercel connection and posts a card in the channel
  you choose; the card is the deploy's record, rewritten in place as the build moves, so the preview
  URL appears in the message that announced it rather than in a second one underneath.
  
  **Database** lists the tables and columns of a connection's database and runs one statement. It goes
  through Perch's MCP gateway on the connection's own token, so nothing new touches a credential, and
  it is read-only: a statement that writes is refused before the provider is asked, with the rule that
  said so. Which tools a provider's database is browsed with comes from its connector manifest.
- 7ffcb04: The Forge: make a bot without writing anything. Settings → Bots has six starting points — Grok
  Newsroom, GPT Helpdesk, Claude Reviewer, Local Llama, 12birb Editor, GAM3 TALK Show Notes — and
  picking one fills the form in: what it is called, what people type after an @, what it is told,
  which brain it runs on, what it may spend, which tools it has and what sets it off. Each bot then
  shows the channels it is in, what it has cost, a pause switch, and a test chat for asking it
  something without saying it in a channel. Bots can also carry skills now — a named way of doing
  something, with its instructions — which go in front of the model with the persona.
- 2918dc6: The inbox: one queue for everything waiting on you. Permission prompts an agent is parked on,
  mentions, threads the rails paused, budgets a bot has run through and runs that failed all land in
  Inbox mode, across every workspace you are in. A permission can be approved or denied from the row
  itself — several at once, if several are waiting — so an agent can be let through from a phone
  without opening the session. Anything else is marked done or put off until tomorrow. On a phone,
  Perch now opens on the Inbox when something needs you.
- a837eea: ⌘K in the editor rewrites a selection: describe the edit, and the agent's version lands in the
  buffer with the replaced lines struck through above it. Accept keeps it and ⌘S writes it; Reject
  puts the original back. Nothing touches the file until you save, and the lane the agent answers on
  stays out of the session list.
- 3417ea3: Interactive blocks. A message can now ask a question — a button, a select, a form, approve or deny,
  and a progress bar that reports without asking anything — and answering it writes the answer into
  the block itself: the message says what was decided, by whom and when, so everybody sees the same
  outcome and it is still there tomorrow. Answering is not editing, so nothing gains an "(edited)"
  mark, and a question is answered once. The payload goes to whoever owns the block over the Bot API
  (`interaction.received`), which is the seam the bot runtime and webhooks will subscribe to.
- f39b87d: Bots that answer. A workspace can now make a bot, give it a persona and a brain, put it in a channel
  and have it reply when it is named — streaming into its message the way a person's typing fills in,
  always in the thread it was asked in. Triggers cover mentions, DMs, keywords, a bot's own arrival, a
  reaction and a cron schedule; the native tools (web search, fetching a page, reading and posting in
  channels, remembering and recalling, thread facts) are each the bot's own, and everything they bring
  back is wrapped as untrusted so a webpage cannot tell a bot what to do. Every turn is on a ledger
  with its tokens and cost, and a bot over its daily budget or its rate limit says so instead of going
  quiet.
- 0985050: The policy engine: one written document says what may happen in a workspace, and a project can
  narrow it. Protected branches, refused commands, paths an agent may write, which models a channel or
  a project may use, ceilings on what may be spent, and how far bots may go tagging each other. A
  channel pinned to local models turns a cloud-brained bot away in the thread it was asked in, a push
  to a protected branch is refused before the runner is asked, and Settings → Policy has a dry run
  beside the document: type what somebody might do and see which rule decides.
- f3aefb9: Projects: create one empty, upload files into one, or clone a repository (public, with an access
  token, or with the workspace's SSH deploy key) from Code mode or the API; the directory is set up on
  a runner, `.perch/project.json` is validated and applied, `devcontainer.json` is read and its
  `postCreateCommand` runs, and the row's status updates live.
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
- 52af50e: Chat carries more than words. React to a message with an emoji and see who else did; attach a file
  and have an image show itself in the flow; paste a Perch identifier — `project:NEST`,
  `channel:general`, `session:8f2c` — and get a card for what it points at, but only ever for things
  you could have opened yourself. And when somebody mentions you while you are not looking, your
  phone says so: Perch registers a service worker, encrypts each notification to that device (RFC
  8291) and identifies itself to the push service with VAPID, so the service carries ciphertext and
  learns nothing about who it is for. Every upload downloads as an attachment and only real image
  types preview, so nothing anybody uploads can run on Perch's origin.
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
- 9b25388: Search. One box finds what was said and what was attached — Postgres full text over messages, names
  over files — with filters for the kind, the channel and the person, and the words you searched for
  marked in each result. A result opens as a peek with "Open full" to the channel it was said in, so
  following one does not lose the list. Everything is scoped to what you could already read: a private
  channel keeps its messages out of everybody else's results, and its attachments with them — reading
  a file now means seeing a message that points at it, which is the last of what ADR-0093 left open.
  A search of 100,000 messages answers in about 50 ms.
- 3764521: The session pane: start a session from Code mode's sidebar, watch the transcript stream with
  collapsed tool cards and diffs, answer permission prompts (Allow once / Always this session /
  Deny), switch between plan and build, see tokens and cost, rename and fork sessions; the api gains
  rename and fork routes.
- cc5c90d: Sessions: the Engine interface with a fake engine and a runner-hosted bridge, the
  coding_sessions/session_events tables, and api routes to open a session in a project, send turns,
  answer permissions, cancel, and replay the transcript from a seq; every event fans out live on the
  session's WS topic.

### Patch Changes

- 365bdc5: Shutting down no longer depends on luck. A closing database now waits for the queries it already
  started and refuses anything that arrives afterwards, and the runner channel finishes marking its
  runners offline before the database goes — so a restart finds them offline rather than online, and a
  shutdown cannot leave PGlite spinning at 100% CPU with a write in flight.
  
  With that fixed, a shutdown also waits for a bot's in-flight run to finish, instead of abandoning it
  with its run row stuck on "running".
- a438fc6: The supervisor entrypoint runs hosted runners: one container per workspace on demand (or one shared
  container with `PERCH_RUNNER_MODE=shared`) from the runner image, with CPU, memory, and pid limits, the
  homes and projects volumes, and a connect token; idle containers are stopped after
  `PERCH_RUNNER_IDLE_MINUTES`. Migration 0004 lets a runner row belong to every workspace and records
  `idle_since`.

## 0.0.1

### Patch Changes

- 027121b: Core packages: the spec §7 contracts as Zod (bus event catalog, WS protocol, runner JSON-RPC, EngineEvent, error shape); an in-process bus with per-topic replay; a Postgres job queue with SKIP LOCKED claims, backoff, cron, and crash recovery; envelope encryption with rotation. Adds the jobs table (migration 0002).
- 85b6bb8: packages/db: the spec §6 schema for identity, tenancy, projects and runners, chat, files, instance_settings, and better-auth's tables; Zod shapes for every jsonb column; one Db type over postgres.js and PGlite; embedded migrations applied under an advisory lock; a PGlite test harness.
- 45c4eee: Laptop mode (task 0.14): `perch dev` runs the api, the web app, and an in-process runner on PGlite under
  `~/.perch`; `perch doctor` checks the machine and the data directory; `perch backup` and `perch restore`
  round-trip the PGlite data, files, and master key as a backup directory. `RunnerLink` in `@perch/events`
  and the api's runner registry (`GET /api/health` now reports `checks.runners` and `mode`) are the seam
  the hosted and local runners plug into next.
- eaa6104: Phase 0 spikes with recorded outcomes: bun-pty replaces node-pty on Bun (ADR-0029); the ACP SDK, OpenCode SDK, PGlite with pgvector, the QuickJS sandbox, better-auth with the Drizzle adapter, and the preview tunnel over an outbound runner socket are verified; dockerode, the Caddy wildcard, and cloudflared are gated on CI resources (ADR-0030..0038).
- e05fb7a: Resolve and pin every dependency named in the spec (docs/dependencies.md), with ADR-0019..0028 for the non-obvious picks; commit the lockfile.
- 62de53e: Workspaces, memberships, RBAC, and the audit log (task 0.9): `authorize(ctx, action, resource)` in
  `@perch/policy` (role matrix + token scopes) applied in every workspace handler, with non-members getting
  `not_found`; `GET/PATCH /api/workspaces/{ws}`, `GET /api/workspaces/{ws}/members`,
  `PATCH/DELETE /api/workspaces/{ws}/members/{user}` (owner rules, last-owner protection, leave);
  the `audit_log` table (migration 0003) written by a bus subscriber for every workspace event, with
  `GET /api/workspaces/{ws}/audit`; bus envelopes now carry `meta` (request id, client ip).
