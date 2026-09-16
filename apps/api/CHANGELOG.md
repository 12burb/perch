# @perch/api

## 0.2.0

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
- 3af96e8: The cli-harness engine, behind the `cli_harness` feature flag (off by default): on a local runner
  or in laptop mode, a session can run Codex (`codex exec --json`) or Claude Code
  (`claude -p --output-format stream-json`) under the person's own login, with the CLIs' streams as
  the transcript and their own sessions resumed turn after turn. Feature flags arrive with it:
  `PERCH_FLAGS` and the `flags` instance setting.
- 9c29082: Connections, part one: the core of connecting a service. A connector is a manifest.yaml describing
  one provider — its lanes, its API base, the scopes to ask for — and GitHub's ships with Perch. You
  can paste a personal access token or install a GitHub App, and either way the secret goes into the
  vault and never comes back out to a caller: a connection shows the account it speaks as and a hint
  like `gi…wxyz`, nothing more. An App connection stores only the private key and mints a fresh
  installation token for each call. Cloning a project can now run on a connection, with the token
  minted for that one clone. The instance publishes its OAuth client metadata document at
  `/.well-known/oauth-client-metadata.json`, whose URL is the client_id it declares.
- d02fde9: Connections, part two: the OAuth lane and opening a pull request. Register your own app with a
  provider, send someone through the authorization, and the callback turns the code into a connection
  — PKCE throughout, with the state single-use so a replayed callback finds nothing. And a project
  cloned through a connection can open a pull request on it: Perch mints the token, the runner pushes
  the branch with it, and the provider is asked to open the PR, all on a credential that is never
  stored and never shown.
- d6528a4: Connections v2: connect anything with a remote MCP server without registering an app first. Perch
  discovers how to authorize at the moment you click Connect — the protected-resource document
  (RFC 9728), the authorization server's metadata (RFC 8414 or OpenID Connect discovery), then who
  Perch is as a client: an app you registered here, this instance's own client metadata document, or
  a client registered on the spot (RFC 7591) — and completes an OAuth 2.1 round-trip with PKCE and a
  resource indicator naming the server the token is for.
  
  Vercel, Supabase and Clerk ship as connectors. **Use my own app** registers your own OAuth client
  with a provider on either sign-in lane, and **Who may use it** on every connection grants it to a
  bot: a connection that is yours can be lent to a bot the whole workspace talks to only on your
  behalf, and both the grant and the call are refused otherwise.
- 3318f0e: Ship from the IDE, and look at your database while you are there. The drawer has two new tabs.
  **Deploy** builds the project's branch through a Vercel connection and posts a card in the channel
  you choose; the card is the deploy's record, rewritten in place as the build moves, so the preview
  URL appears in the message that announced it rather than in a second one underneath.
  
  **Database** lists the tables and columns of a connection's database and runs one statement. It goes
  through Perch's MCP gateway on the connection's own token, so nothing new touches a credential, and
  it is read-only: a statement that writes is refused before the provider is asked, with the rule that
  said so. Which tools a provider's database is browsed with comes from its connector manifest.
- b144df4: Review what an agent changed: a Changes view in the session pane shows the diff of one turn or of
  the whole session, with labelled hunks you accept or reject one at a time, Accept all / Reject all
  per file, and Open to jump to the file. Rejecting a hunk takes just those lines back out. Every
  turn now takes a checkpoint of the project first, so any turn can be restored from the transcript,
  and a code block in a reply can be applied to the file its fence names.
- df9ec50: The editor: open a project from Code mode to browse its file tree, edit files in CodeMirror 6 with
  tabs and breadcrumbs, save with ⌘S, search the project, and preview markdown and images; the api
  gains per-project file routes that forward to the project's runner.
- fa24434: Commit without leaving the page. The drawer has a Git tab beside the terminal: the files that
  changed with a tick box each, a commit message you can write or have the project's agent write from
  the diff, and buttons to branch, push, and open a pull request. Push and Open PR borrow a
  connection's credential for exactly one call. Every one of them is also a REST route, so a script
  can do the same.
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
- a451282: The inspector. Press **Inspect** (or ⌘⇧C) in the Preview tab and click something in the page: Perch
  tells you what it is, shows the Elements tree, and — with the `@perch/inspector` dev plugin in the
  project — says which file and line it was written at. **Use as context** turns that into a chip on
  the session composer, so "make this primary" edits the file you pointed at.
  
  The console and failed-requests strip collects what the page logged and every request that came back
  not-ok, each with **Send to agent**. **Screenshot** asks the runner's own headless browser for a
  picture, which is either attached to the next turn or posted straight into a channel.
  
  The client is injected by the preview proxy only for a member's own preview pane, signed with a
  nonce per response, and never for a share link.
- 3417ea3: Interactive blocks. A message can now ask a question — a button, a select, a form, approve or deny,
  and a progress bar that reports without asking anything — and answering it writes the answer into
  the block itself: the message says what was decided, by whom and when, so everybody sees the same
  outcome and it is still there tomorrow. Answering is not editing, so nothing gains an "(edited)"
  mark, and a question is answered once. The payload goes to whoever owns the block over the Bot API
  (`interaction.received`), which is the seam the bot runtime and webhooks will subscribe to.
- de84546: Local runners: the Environments page lists a workspace's runners with live status, "Connect a machine"
  mints a connect token shown once inside the `perch runner connect` command, owners and admins remove
  runners, and `perch runner connect <url> --token …` joins a machine as one of your environments.
- fb30b24: Agents can use a connection's tools without ever holding its credential. Every connection whose
  provider has an MCP server is now one itself, at `/mcp/{connectionId}`: a session is handed that
  URL and a token Perch minted for it, and Perch attaches the provider's real credential on the way
  out. A grant's allow-list decides which tools a session may call — a refusal never reaches the
  provider — and every call is audited with the tool, the caller, and a hash of its arguments. A
  connection may override its provider's MCP URL for a self-hosted host, the way it already can for
  the REST API.
- f39b87d: Bots that answer. A workspace can now make a bot, give it a persona and a brain, put it in a channel
  and have it reply when it is named — streaming into its message the way a person's typing fills in,
  always in the thread it was asked in. Triggers cover mentions, DMs, keywords, a bot's own arrival, a
  reaction and a cron schedule; the native tools (web search, fetching a page, reading and posting in
  channels, remembering and recalling, thread facts) are each the bot's own, and everything they bring
  back is wrapped as untrusted so a webpage cannot tell a bot what to do. Every turn is on a ledger
  with its tokens and cost, and a bot over its daily budget or its rate limit says so instead of going
  quiet.
- 76ae435: The OpenCode engine: runners start `opencode serve` per project (the pinned binary ships in the
  runner image) and drive it through the SDK, so a session runs OpenCode's build or plan agent with
  tool calls, the edit tools' diffs, permission prompts, usage, and cancellation flowing through the
  session routes.
- 0985050: The policy engine: one written document says what may happen in a workspace, and a project can
  narrow it. Protected branches, refused commands, paths an agent may write, which models a channel or
  a project may use, ceilings on what may be spent, and how far bots may go tagging each other. A
  channel pinned to local models turns a cloud-brained bot away in the thread it was asked in, a push
  to a protected branch is refused before the runner is asked, and Settings → Policy has a dry run
  beside the document: type what somebody might do and see which rule decides.
- fe9fbdd: Watch a project run. Every port a project's runner is serving now appears in Code mode's Previews
  sidebar and opens in a Preview tab beside the editor (⌘⇧P): an address bar, back and forward,
  reload, viewport presets with rotate, and a link out to a real tab. HMR passes straight through, so
  a Vite app hot-reloads inside the tab with no configuration when the instance has a preview domain.
  Share mints an expiring, revocable link that opens the preview for someone with no Perch account,
  and shows the dev server's own page — never an injected inspector.
- 5f61320: Previews work on a laptop too. A runner connected with `perch runner connect` is usually behind a
  network the server cannot reach into, so its previews now travel back through the WebSocket the
  runner already opened: Perch asks the runner to make the request, and the answer — or a whole
  WebSocket, relayed frame for frame, HMR included — comes back on a stream. Nothing changes in the
  Preview tab; a dev server on your laptop is simply watchable from your phone.
- c4e921c: A project's environment: the variables its sessions, terminals and dev servers run with, encrypted
  at rest and write-only — a value goes in once, and the api only ever answers with the keys. The
  values are put in front of an agent's process and a terminal's shell, and taken out of everything
  written down: an agent that prints `$DATABASE_URL` leaves `[redacted: DATABASE_URL]` in the
  transcript, so the record people read and the transcript a model is shown later carry the name
  rather than the secret.
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
- 0d33a89: Runners answer the fs (list, read, write, stat, ripgrep-backed search), git (status, diff, commit,
  push, branch, worktrees), ports, and exec methods, every call through a policy hook with built-in
  rules (destructive commands, publishes, force pushes, git internals, exec confined to the projects
  root); the Environments list shows each runner's listening ports and the api answers them live.
- 9b25388: Search. One box finds what was said and what was attached — Postgres full text over messages, names
  over files — with filters for the kind, the channel and the person, and the words you searched for
  marked in each result. A result opens as a peek with "Open full" to the channel it was said in, so
  following one does not lose the list. Everything is scoped to what you could already read: a private
  channel keeps its messages out of everybody else's results, and its attachments with them — reading
  a file now means seeing a message that points at it, which is the last of what ADR-0093 left open.
  A search of 100,000 messages answers in about 50 ms.
- bb1f0e5: Secret scanning before every commit. What a commit is about to take — including the files an agent
  has just written, which git has never seen — is read for the shapes providers stamp on their tokens,
  private keys, passwords in connection strings, and names that say secret beside a long value. A
  finding stops the commit and the Git panel shows a card saying what it is and which line it is on,
  with the value masked. Nothing is committed, so taking it out and committing again is all it takes.
  Placeholders, example files and lines being removed are left alone, and a repository can name its
  own exceptions in its policy.
- 3764521: The session pane: start a session from Code mode's sidebar, watch the transcript stream with
  collapsed tool cards and diffs, answer permission prompts (Allow once / Always this session /
  Deny), switch between plan and build, see tokens and cost, rename and fork sessions; the api gains
  rename and fork routes.
- cc5c90d: Sessions: the Engine interface with a fake engine and a runner-hosted bridge, the
  coding_sessions/session_events tables, and api routes to open a session in a project, send turns,
  answer permissions, cancel, and replay the transcript from a seq; every event fans out live on the
  session's WS topic.
- a438fc6: The supervisor entrypoint runs hosted runners: one container per workspace on demand (or one shared
  container with `PERCH_RUNNER_MODE=shared`) from the runner image, with CPU, memory, and pid limits, the
  homes and projects volumes, and a connect token; idle containers are stopped after
  `PERCH_RUNNER_IDLE_MINUTES`. Migration 0004 lets a runner row belong to every workspace and records
  `idle_since`.
- f0ff645: The terminal: Code mode's drawer opens a shell on the project's runner (xterm.js), per person,
  inside tmux where the machine has it; a reload or a reopened drawer comes back to the same shell
  with its scrollback, and file paths printed in the output open in the editor. Runners answer
  `pty.open/input/resize/close` and carry terminal data over `/api/runner/stream/{token}` sockets.

### Patch Changes

- d11b588: Home has channels. Start a public or private one, join the public ones, set a topic, see who is in
  each, and leave when you are done; owners and admins archive a channel when it has served its
  purpose. The sidebar lists the channels you are in, heaviest first — the ones with the most waiting
  for you. Messages land next.
- e5c8bd7: ⌘K: leaving a file with a proposal unanswered now puts the original text back, as the docs always
  said it did. Switching tabs, closing the tab, toggling a markdown preview, or pressing ⌘K again all
  reject a standing proposal first — before this, only the bar went away and the agent's rewrite
  stayed in the buffer with no way to review or undo it, and ⌘S would write it to disk. A reply that
  arrives after you have moved to another file is dropped instead of landing there, and an inline
  lane whose runner reconnected re-opens itself on the next ⌘K rather than failing forever.
- 7fd4a59: Channels have messages. Say something and everybody in the channel sees it; reply in a thread and
  the message keeps its reply count; pin what matters to the channel, save what matters to you; edit
  what you wrote, with the history one click away; delete it and leave a hole rather than a lie. Type
  `@` or `#` in the composer to name a person or a channel, and what is unread goes quiet when you
  read it.
- ea81bde: The runner control channel (spec §7.6): runners connect to `/api/runner` with a connect token, register,
  heartbeat, and answer api requests that carry per-request capability tokens; the runner image now runs
  the runner agent as its entrypoint (`PERCH_API_URL`, `PERCH_RUNNER_TOKEN`).
- 365bdc5: Shutting down no longer depends on luck. A closing database now waits for the queries it already
  started and refuses anything that arrives afterwards, and the runner channel finishes marking its
  runners offline before the database goes — so a restart finds them offline rather than online, and a
  shutdown cannot leave PGlite spinning at 100% CPU with a write in flight.
  
  With that fixed, a shutdown also waits for a bot's in-flight run to finish, instead of abandoning it
  with its run row stuck on "running".
- 6cc4171: Previews through a laptop's tunnel come back whole. The runner used to hang up on a stream as soon
  as it had sent the answer, and a client socket throws away whatever it has not written yet — so a
  large page could arrive with its tail missing and nothing to say so. The runner now leaves the
  hang-up to the api, which closes once it has everything, and a stream that dies mid-answer fails the
  request instead of quietly truncating it.
- Updated dependencies [378589c]
- Updated dependencies [9246f90]
- Updated dependencies [ea3b91b]
- Updated dependencies [ed9f649]
- Updated dependencies [347ce60]
- Updated dependencies [9c29082]
- Updated dependencies [d6528a4]
- Updated dependencies [3318f0e]
- Updated dependencies [b144df4]
- Updated dependencies [7ffcb04]
- Updated dependencies [2918dc6]
- Updated dependencies [a837eea]
- Updated dependencies [a451282]
- Updated dependencies [3417ea3]
- Updated dependencies [de84546]
- Updated dependencies [fb30b24]
- Updated dependencies [f39b87d]
- Updated dependencies [0985050]
- Updated dependencies [fe9fbdd]
- Updated dependencies [5f61320]
- Updated dependencies [c4e921c]
- Updated dependencies [f3aefb9]
- Updated dependencies [eb5cdaa]
- Updated dependencies [52af50e]
- Updated dependencies [8d7d282]
- Updated dependencies [ea81bde]
- Updated dependencies [0d33a89]
- Updated dependencies [9b25388]
- Updated dependencies [bb1f0e5]
- Updated dependencies [3764521]
- Updated dependencies [cc5c90d]
- Updated dependencies [365bdc5]
- Updated dependencies [a438fc6]
- Updated dependencies [f0ff645]
  - @perch/engines@0.1.0
  - @perch/events@0.1.0
  - @perch/db@0.1.0
  - @perch/bots@0.1.0
  - @perch/gateway@0.1.0
  - @perch/policy@0.1.0
  - @perch/connect@0.1.0
  - @perch/connectors@0.1.0
  - @perch/inspector@0.1.0
  - @perch/preview@0.1.0
  - @perch/repo@0.1.0
  - @perch/bus@0.0.2
  - @perch/jobs@0.0.2

## 0.1.0

### Minor Changes

- The first downloadable release: `perch` binaries for Linux (x64, arm64), macOS (arm64, x64), and Windows
  (x64) with the web app embedded, and the `perch-desktop` app for Linux, macOS, and Windows, all built and
  attached to the GitHub release by the release workflow.

### Patch Changes

- 5f7bace: The api image ships a production-only runtime tree: the api workspace, the packages it links, and the
  web build, with no dev tools, spike dependencies, or native build binaries, on a base image with Debian
  security updates applied. Spike packages declare their libraries as devDependencies.
- 803f280: The api image builds again: the `connectors` and `templates` workspaces are copied into the build stage
  (a frozen `bun install` needs every workspace in the lockfile), and a `.dockerignore` keeps installs,
  builds, and `.env` files out of the build context.
- 9d8ca25: apps/api skeleton: Hono + zod-openapi with the OpenAPI document at /api/openapi.json, the §7.8 error model with request ids, pino request logging with secret redaction, Perch-Version handling, GET /api/health and /api/version, boot wiring (env → db migrations → bus, vault, queue), and the generated TypeScript client (@perch/api-client) typed end to end.
- ed5ab78: Authentication (task 0.8): better-auth on the Drizzle adapter with email + password, passkeys
  (`@better-auth/passkey`, bound to `PERCH_PUBLIC_URL`), and generic OIDC through `PERCH_OIDC_*`; a Perch
  `users` profile row for every auth user; `GET/PATCH /api/me`; api tokens (`/api/me/tokens`, shown once,
  stored hashed, accepted as `Bearer pat_…`); workspaces with owner memberships; email invites
  (`POST /api/workspaces/{ws}/invites`, public preview, accept bound to the invited email); a public
  `GET /api/instance`; the first web routes (sign in, sign up, invite, security settings) with `t()` strings
  and design tokens from `@perch/ui`; Playwright e2e (`bun run e2e`) covering sign up, passkey sign-in, api
  tokens, and invite acceptance at 1440 px and 390 px.
- b7d9c3a: CI and releases (task 0.15): the pull-request pipeline (Biome, typecheck, unit tests on PGlite and
  Postgres, SDK drift, perf budgets, component tests with axe, Playwright from the setup wizard, the
  laptop smoke on Linux/macOS/Windows, the compose smoke with Trivy), weekly CodeQL, the changesets
  version pull request, and the tag release: multi-arch images on GHCR signed with cosign with attested
  SBOMs, perch binaries per platform with the web app embedded, and the `perch-dev` npm package.
- ae3e4ab: Deploy (task 0.13): `deploy/Dockerfile.api` (Bun runtime, Vite build under Node, non-root, `api | worker |
  supervisor`), `deploy/Dockerfile.runner` (the Ubuntu 24.04 runner base), `deploy/Dockerfile.caddy`
  (Caddy with a DNS-challenge module), the pinned `docker-compose.yml` with the `local` and `tunnel`
  profiles, the Caddyfiles, `.env.example`, `perch init` (writes `.env` with generated secrets, the compose
  file, and the Caddyfile), and the setup wizard: `POST /api/setup` creates the admin, the first workspace,
  confirms `PERCH_PUBLIC_URL`, records the telemetry choice, and sign-ups stay closed until it has run.
- b55c1a4: Governance files: README with the 60-second install, CONTRIBUTING (DCO, no CLA), CODE_OF_CONDUCT (Contributor Covenant 2.1), SECURITY (GitHub Security Advisories, 3-day ack, 90-day disclosure), GOVERNANCE, PLEDGE, docs/telemetry.md, docs/policies/providers.md, the RFC template, and a DCO check enforced in CI.
- 833ab7d: The jobs worker no longer crashes at boot in team mode: the claim query binds its timestamps through the
  column encoders instead of interpolating Dates into a raw sql template, which postgres.js could not
  serialize under drizzle's transparent timestamp serializers. The queue suite now runs on Postgres as
  well as PGlite in CI.
- 45c4eee: Laptop mode (task 0.14): `perch dev` runs the api, the web app, and an in-process runner on PGlite under
  `~/.perch`; `perch doctor` checks the machine and the data directory; `perch backup` and `perch restore`
  round-trip the PGlite data, files, and master key as a backup directory. `RunnerLink` in `@perch/events`
  and the api's runner registry (`GET /api/health` now reports `checks.runners` and `mode`) are the seam
  the hosted and local runners plug into next.
- e05fb7a: Resolve and pin every dependency named in the spec (docs/dependencies.md), with ADR-0019..0028 for the non-obvious picks; commit the lockfile.
- 3ab9ae7: Scaffold the monorepo: Bun workspaces, Turborepo, Biome, strict TypeScript, Changesets, Renovate, PR and issue templates, the AGPL-3.0 / MIT license split, and repository invariant tests.
- 62de53e: Workspaces, memberships, RBAC, and the audit log (task 0.9): `authorize(ctx, action, resource)` in
  `@perch/policy` (role matrix + token scopes) applied in every workspace handler, with non-members getting
  `not_found`; `GET/PATCH /api/workspaces/{ws}`, `GET /api/workspaces/{ws}/members`,
  `PATCH/DELETE /api/workspaces/{ws}/members/{user}` (owner rules, last-owner protection, leave);
  the `audit_log` table (migration 0003) written by a bus subscriber for every workspace event, with
  `GET /api/workspaces/{ws}/audit`; bus envelopes now carry `meta` (request id, client ip).
- 1d93dfb: WebSocket server at `/api/ws` (task 0.10, spec §7.2): subscribe/unsubscribe with per-topic
  authorization, `resume { topic, after_seq }` from the replay buffer (or `resync` when it fell off),
  presence per user per workspace with a `presence_snapshot` on subscribe, rate-limited typing on channel
  topics, and the web client (`PerchSocket`, `usePresence`) showing who is online per workspace.
- Updated dependencies [027121b]
- Updated dependencies [85b6bb8]
- Updated dependencies [833ab7d]
- Updated dependencies [45c4eee]
- Updated dependencies [eaa6104]
- Updated dependencies [e05fb7a]
- Updated dependencies [62de53e]
- Updated dependencies [1d93dfb]
  - @perch/events@0.0.1
  - @perch/bus@0.0.1
  - @perch/jobs@0.0.1
  - @perch/vault@0.0.1
  - @perch/db@0.0.1
  - @perch/policy@0.0.1
