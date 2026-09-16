# @perch/web

## 0.2.0

### Minor Changes

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
- a6dd141: Connections, part three: the card. Workspace settings gains a Connections section — connect a
  service by pasting a token, signing in, or installing a GitHub App, then test or disconnect it.
  The App wizard prefills the callback and webhook URLs GitHub asks for, so nobody has to work out
  their own instance's public URL, and each is one click to copy. A row shows the account a
  connection speaks as and never the credential behind it.
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
- 7ffcb04: The Forge: make a bot without writing anything. Settings → Bots has six starting points — Grok
  Newsroom, GPT Helpdesk, Claude Reviewer, Local Llama, 12birb Editor, GAM3 TALK Show Notes — and
  picking one fills the form in: what it is called, what people type after an @, what it is told,
  which brain it runs on, what it may spend, which tools it has and what sets it off. Each bot then
  shows the channels it is in, what it has cost, a pause switch, and a test chat for asking it
  something without saying it in a channel. Bots can also carry skills now — a named way of doing
  something, with its instructions — which go in front of the model with the persona.
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
- 94da876: Long lists stay fast, and CI keeps them that way. Home's channel list and the Git panel's changed
  files now render only the rows you can see, through one shared `VirtualList` that tells a screen
  reader how long the list really is. The sidebar's Channels, DMs and Bots sections show the thirty
  most relevant rooms and a link to the rest. And `bun run perf` now audits every list in the app:
  each one is virtualized, capped somewhere the check can read, or has a written reason — and a new
  screen with a scrolling list fails the build until it says which.
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
- fe9fbdd: Watch a project run. Every port a project's runner is serving now appears in Code mode's Previews
  sidebar and opens in a Preview tab beside the editor (⌘⇧P): an address bar, back and forward,
  reload, viewport presets with rotate, and a link out to a real tab. HMR passes straight through, so
  a Vite app hot-reloads inside the tab with no configuration when the instance has a preview domain.
  Share mints an expiring, revocable link that opens the preview for someone with no Perch account,
  and shows the dev server's own page — never an injected inspector.
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
- e940d4f: Clone a repository through a service you have already connected: pick "A connected service" under
  Authentication in Code mode and Perch mints a token for that one clone. Connections can also point
  at a service you host yourself — a GitHub Enterprise Server, say — with the new API base field.
  
  A runner can be told about an `opencode serve` that is already running (`PERCH_OPENCODE_URL`)
  instead of starting one per project.
  
  Phase 1's exit criterion now runs on every push as one Playwright spec, four times over: clone via
  GitHub, ask for a change, watch it in Preview from a phone, review the diff, commit, open a pull
  request — on a key, on Ollama, through OpenCode, and through ACP.
- fcf2a0b: Phase 2's exit criterion runs as one Playwright spec: a team of three in one workspace for an
  afternoon — a bot answering in #general, three bots fanning out and a pair tripping the breaker, a
  Vercel deploy whose card in the thread becomes the preview URL, a change asked for by pointing at
  the page, a channel that refuses a cloud model, and a permission approved from a phone — with an
  accessibility sweep on Home, Code and Inbox as each is reached.
- 794be60: A project that finished setting up no longer waits for a reload to say so. Code's project list
  refetches while anything is being set up, so a missed socket event — a reconnect, a subscribe that
  landed a moment late — no longer leaves "Setting up" on a project that is ready.
- Updated dependencies [378589c]
- Updated dependencies [9246f90]
- Updated dependencies [ea3b91b]
- Updated dependencies [ed9f649]
- Updated dependencies [347ce60]
- Updated dependencies [a6dd141]
- Updated dependencies [d6528a4]
- Updated dependencies [3318f0e]
- Updated dependencies [b144df4]
- Updated dependencies [df9ec50]
- Updated dependencies [7ffcb04]
- Updated dependencies [fa24434]
- Updated dependencies [2918dc6]
- Updated dependencies [a837eea]
- Updated dependencies [a451282]
- Updated dependencies [3417ea3]
- Updated dependencies [de84546]
- Updated dependencies [94da876]
- Updated dependencies [fb30b24]
- Updated dependencies [7fd4a59]
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
- Updated dependencies [bb1f0e5]
- Updated dependencies [3764521]
- Updated dependencies [cc5c90d]
- Updated dependencies [a438fc6]
- Updated dependencies [f0ff645]
  - @perch/events@0.1.0
  - @perch/bots@0.1.0
  - @perch/ui@0.1.0
  - @perch/api-client@0.1.0

## 0.1.0

### Minor Changes

- The first downloadable release: `perch` binaries for Linux (x64, arm64), macOS (arm64, x64), and Windows
  (x64) with the web app embedded, and the `perch-desktop` app for Linux, macOS, and Windows, all built and
  attached to the GitHub release by the release workflow.

### Patch Changes

- ed5ab78: Authentication (task 0.8): better-auth on the Drizzle adapter with email + password, passkeys
  (`@better-auth/passkey`, bound to `PERCH_PUBLIC_URL`), and generic OIDC through `PERCH_OIDC_*`; a Perch
  `users` profile row for every auth user; `GET/PATCH /api/me`; api tokens (`/api/me/tokens`, shown once,
  stored hashed, accepted as `Bearer pat_…`); workspaces with owner memberships; email invites
  (`POST /api/workspaces/{ws}/invites`, public preview, accept bound to the invited email); a public
  `GET /api/instance`; the first web routes (sign in, sign up, invite, security settings) with `t()` strings
  and design tokens from `@perch/ui`; Playwright e2e (`bun run e2e`) covering sign up, passkey sign-in, api
  tokens, and invite acceptance at 1440 px and 390 px.
- ae3e4ab: Deploy (task 0.13): `deploy/Dockerfile.api` (Bun runtime, Vite build under Node, non-root, `api | worker |
  supervisor`), `deploy/Dockerfile.runner` (the Ubuntu 24.04 runner base), `deploy/Dockerfile.caddy`
  (Caddy with a DNS-challenge module), the pinned `docker-compose.yml` with the `local` and `tunnel`
  profiles, the Caddyfiles, `.env.example`, `perch init` (writes `.env` with generated secrets, the compose
  file, and the Caddyfile), and the setup wizard: `POST /api/setup` creates the admin, the first workspace,
  confirms `PERCH_PUBLIC_URL`, records the telemetry choice, and sign-ups stay closed until it has run.
- e05fb7a: Resolve and pin every dependency named in the spec (docs/dependencies.md), with ADR-0019..0028 for the non-obvious picks; commit the lockfile.
- 3ab9ae7: Scaffold the monorepo: Bun workspaces, Turborepo, Biome, strict TypeScript, Changesets, Renovate, PR and issue templates, the AGPL-3.0 / MIT license split, and repository invariant tests.
- 1e8a4fa: `@perch/ui` (task 0.11): the §4 design tokens (dark-first + light, density, motion, semantic colors) with
  the Tailwind v4 theme mapping, `useTheme`, the shadcn-style base (Button, IconButton, Input, Textarea,
  Label, Field, Separator, Badge, BotBadge, Avatar, Kbd, Tooltip, Dialog, Sheet), and the shell components
  (Shell, Rail, Sidebar, Panel, Drawer, MobileTabBar, Peek, CommandPalette, Composer skeleton, EmptyState),
  each with Playwright component tests at 1440 px and 390 px that pass axe.
- 905d933: The web shell (task 0.12): the §4 layout on every signed-in page with the six rail tabs (Home, Code,
  Work, Bots, Inbox, Search) under `/$workspace/$mode`, the mobile tab bar with a More sheet, per-mode
  sidebars and one-line empty states, the command palette (⌘K), a workspace switcher, a welcome page that
  creates the first workspace, and settings for the profile (name, handle, locale, time zone, theme,
  density), security (passkeys, api tokens), and the workspace (name, slug, members and roles, invites,
  audit log). Screenshots at 1440 px and 390 px live in docs/screenshots/0.12.
- 1d93dfb: WebSocket server at `/api/ws` (task 0.10, spec §7.2): subscribe/unsubscribe with per-topic
  authorization, `resume { topic, after_seq }` from the replay buffer (or `resync` when it fell off),
  presence per user per workspace with a `presence_snapshot` on subscribe, rate-limited typing on channel
  topics, and the web client (`PerchSocket`, `usePresence`) showing who is online per workspace.
- Updated dependencies [9d8ca25]
- Updated dependencies [ed5ab78]
- Updated dependencies [027121b]
- Updated dependencies [ae3e4ab]
- Updated dependencies [45c4eee]
- Updated dependencies [e05fb7a]
- Updated dependencies [1e8a4fa]
- Updated dependencies [905d933]
- Updated dependencies [62de53e]
- Updated dependencies [1d93dfb]
  - @perch/api-client@0.0.1
  - @perch/ui@0.0.1
  - @perch/events@0.0.1
