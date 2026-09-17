# @perch/db

## 0.2.0

### Minor Changes

- 82cb101: Agent bots. A bot with an `engine` and `projects` in its spec no longer answers from a model: a
  mention opens a coding session on that project and posts a session card in the thread, with a link
  straight into Code mode. Permissions the engine asks for arrive as Approve / Deny cards in the same
  thread, and answering one answers the engine.
  
  When the session finishes, what the agent left behind is put on a branch of its own, read for
  secrets, committed, pushed and opened as a pull request — the thread gets a diff card with what
  changed, Open in IDE, and the pull request. `pullRequest: false` leaves the work in the session, and
  a project with no repository, no connection, or a change with a credential in it stops there and
  says so rather than failing quietly.
- b579c03: Background sessions. Start a run with `POST …/sessions/background` and a channel to report in, and
  it works to a finish line while nobody watches — then settles, instead of holding a runner open for
  a turn nobody is going to type. It keeps **one card** in that channel, rewritten in place rather
  than a message per event: what it was asked, where it got to, the tool it is stuck on, and at the
  end its turns, tool calls, files changed, cost and how long it took.
  
  Your phone hears only what needs you. `background.notify` in `.perch/project.json` is `needs_you`
  by default — a permission it is waiting on, or a failure — and can be `always` or `never`.
- f519b64: Backups you can trust. A Perch now takes one on a schedule — `PERCH_BACKUP_DIR` turns it on,
  `PERCH_BACKUP_CRON` says when, `PERCH_BACKUP_KEEP` says how many to keep — and `/api/admin/backup`
  takes one now and lists what is there. A backup is a directory: the database as a gzipped
  JSON-lines dump, the files beside it, the project volumes added by the supervisor, and a manifest.
  
  The dump is Perch's own format rather than `pg_dump` or PGlite's data directory, so **a laptop
  backup restores into a team instance on Postgres, and back**. Restoring is "migrate, then load",
  which also means a backup restores into a later Perch:
  
  ```sh
  docker compose exec api bun apps/api/src/index.ts backup
  docker compose exec -e DATABASE_URL=…/perch_restore api bun apps/api/src/index.ts restore /data/backups/<id>
  perch backup ./today && perch restore ./today --portable
  ```
  
  The vault key is **not** in a backup unless you ask (`PERCH_BACKUP_INCLUDE_KEY=on`): its
  fingerprint is, so a restore says plainly whether the key you have is the key those rows were
  encrypted with. Restoring into an instance that already has rows is refused rather than merged.
  
  CI restores a backup on every push, in both modes — laptop on Linux, macOS and Windows, and team
  into an empty Postgres database beside the live one.
- 31b4dba: A bot can be code. Put a `bot.js` beside its `bot.yaml` in a repository and the bot answers with its
  own JavaScript instead of a model: `export default bot({ onMessage, onSchedule, onWebhook })`, with
  `perch.chat_post(…)` and the rest of the tools its spec allows. It runs in QuickJS with no network,
  no filesystem and no host — and under a ceiling, so a bot that loops is stopped and says so where it
  was asked rather than taking anything else with it.
- fe0a09f: Bots can use an MCP server. A bot's spec names connections under `mcp:`, the grant decides which of
  their tools it actually gets, and each one arrives in the turn as `mcp__<provider>__<tool>` with its
  answer wrapped as untrusted. The call goes out through the MCP gateway on the connection's own
  token — the credential never reaches the bot's context.
  
  A grant can mark tools `requires_permission`. Calling one of those parks the call instead of running
  it: an Approve / Deny card appears in the thread and an item in the inbox of whoever set the bot
  running. Approving runs it then, re-checking the grant first, and posts the result in the thread.
  `GET /api/workspaces/{ws}/bot-tool-calls` lists what is waiting.
- c3fe0bd: A merge queue. Branches land one at a time, each rebased onto what landed before it and each held
  to the project's own checks — whatever `.perch/project.json` calls `check`, `test`, `ci` or
  `verify`. Three agents can now finish three branches at once and have them arrive in order rather
  than in a heap.
  
  A branch that will not rebase, or whose checks go red, does not stop the queue: it is marked with
  git's own words or the tail of the command's output, its work item goes to Needs you, and the
  session that wrote it is asked to fix what it broke. The next branch lands meanwhile.
  
  The thread gets one queue card per branch, rewritten in place as it moves from waiting to landing
  to landed — so a thread reads as a queue rather than four notifications.
  
  Under it: `git.merge` on the runner does the rebase and the fast-forward as one operation, because
  two of those racing is what a queue exists to prevent, and `worktree.create` now answers with where
  a branch already is rather than refusing to make a second one.
- 5549cfd: Budgets and the spending screen. Every model call — the gateway's and a bot's — now lands in one
  ledger, so **Settings → Spending** can say what a workspace spent, by model, by provider, by who, or
  by day. Set a ceiling for the workspace, a person or a bot, over a day, a month or forever: the
  tightest one wins, a warning goes out as it is approached, and when it is reached the next `/v1`
  call is a `402` and the next bot answer is the bot saying so in the thread.
- a5fe8a8: The rest of Work mode. Cycles with a burndown that says what was left each day and who finished it
  — an agent or a person — and a Close that carries the unfinished work into the next cycle rather
  than pretending it is done. Modules. Saved views: a layout, what to filter by and what to show,
  yours until you share them. The four layouts beside the board — list, calendar, timeline and
  spreadsheet. The Intake triage queue, where anything that arrived rather than being typed waits to
  be accepted (with the type and cycle you give it) or declined. Sub-items and relations, written
  from both ends. And a work item's description is now a document, written in the panel beside
  everything else about the item.
- 7ccdff3: Starter stacks, one-click projects, and a Perch that starts with something in it.
  
  `templates/` now holds four starter stacks — a Bun API, a Next.js app, a FastAPI service and a
  static site — served at `GET /api/templates` and pickable from Code mode's New project form.
  Choosing one makes a project that arrives with the stack's files and its own `.perch/project.json`
  already read, so Perch knows the run commands and the preview's port before you touch anything.
  
  The Preview tab can now start it: **Start** runs the project's own `preview.command` on its runner,
  waits for the port, and shows the tail of the dev server's output if it does not come up. **Stop**
  takes it down, along with everything it started.
  
  A fresh instance no longer opens on a set of empty states: `PERCH_DEMO_WORKSPACE` (on by default)
  seeds the first workspace with three channels, two bots and a project from a starter stack just
  after the setup wizard, and `perch demo` does the whole thing in one command on a laptop.
- 714f396: Orchestrators can split a job. A bot with `orchestrator: true` and the `fan_out` tool takes a whole
  plan in one call — who does what, and whether to wait for all of them, the first, or a quorum — and
  the thread gets a plan card showing each specialist, what they were asked, and what they may spend,
  rewritten in place as answers land.
  
  What is left of the thread's budget is divided evenly among the bots actually tagged, and each share
  is that bot's alone: the first to run can no longer spend what the others were promised. Every reply
  comes back to the orchestrator at once, wrapped as untrusted, for it to fold into one answer.
  
  A bot without the flag that calls `fan_out` is told so, and nobody is tagged.
- cf4673b: Preflight before push. Set `preview.preflight` in `.perch/project.json` and a push runs the
  project's own lint, test and build, then opens each of its configured routes in the runner's browser
  and looks at them. A console error or a request that did not come back is a failure — the half a
  test suite cannot do, because a page that throws on load passes every unit test ever written.
  
  `block` refuses the push with the checklist; `warn` pushes and shows it anyway; absent is off. Run it
  on its own with `POST …/preflight`, and with a channel it posts the checklist card: a row per check,
  the reason for each failure, and the picture taken of each route.
  
  The runner now drives its browser over the DevTools protocol rather than `--screenshot`, because
  that is the only way to know which console lines the page thought were errors. Screenshots are
  unchanged; they just come back knowing more.
- 3ba2508: Race mode. Ask two to eight engines the same question at once, each in a worktree of its own, and
  get back a comparison rather than an answer: what each one changed, what it cost, and what the
  project's checks made of it. Press **Pick** on the row you want, or let the checks decide — they
  take the cheapest entrant that passes, smallest diff breaking a tie. The winner's branch lands
  through the merge queue like any other; every other entrant gives its directory back and keeps its
  branch, so what the engine that lost was thinking is still there to read.
  
  Sessions that nobody opened by hand — a work item's, a race entrant's — now carry `unattended` and
  settle when their round goes quiet, instead of holding a runner open for a next turn that is never
  coming.
- 00f1986: The reliability bar: a hundred sessions at once, an upgrade with no data loss, a runner killed
  mid-turn.
  
  `bun run reliability` runs three drills against published targets (`docs/reliability.md`), and CI
  runs it on every push. A hundred sessions open and answer in 7.3 seconds, and with all hundred held
  the next session still opens in about sixteen milliseconds. A database one migration behind upgrades
  with every row intact, and a backup restores into a database that was migrated a moment ago.
  
  The chaos drill found a real bug and this release fixes it: a session whose runner died stayed
  `running` for ever. The watchdog cancelled the round by asking the engine to stop, and an engine
  whose runner is gone cannot be asked anything. Perch now ends such a round itself and the session
  says "the agent stopped answering and its runner could not be reached" instead of claiming to be
  working.
- c2a9d67: A bot's schedule now means the hour you meant. `timezone: Europe/London` on a bot reads
  `0 9 * * 1-5` as nine in the morning there, and follows it across a daylight-saving change; a zone
  name that does not exist is refused when the bot is saved. A firing Perch was down for runs late by
  default, up to an hour, and a bot whose message only makes sense on time can say `catch_up: false`.
  And a new schedules endpoint says, for each one, when it next fires and when it last did.
- 3fdf6c1: A bot can live in a repository. Put `bots/<handle>/bot.yaml` next to a `SYSTEM.md` and a `skills/`
  folder in any project, and Perch reads it: the bot appears in the workspace, answers where it is
  installed, and keeps its persona and skills in version control where they can be reviewed like
  anything else. Pushing from the Git panel reloads them; the panel's Reload bots button does the
  same after a pull, and says which directory Perch could not read.
- 53b90b0: The testing loop. Put `background.testLoop` in `.perch/project.json` and the project's own tests run
  after any round that wrote something — in the session's worktree, or its checkout — and a failure
  goes straight back to the agent as the next turn, with the command and what it said. It gets two
  tries by default (five at most); after that the session stops at **needs you** with what still
  fails, where the inbox and the background card already look.
  
  A round that only answered a question is not tested, a round that errored is not told off for it,
  and leaving `testLoop` out leaves everything as it was.
- 4c68089: The model gateway at `/v1`. Point an OpenAI client at your Perch, use a virtual key where the API
  key goes and a brain's name where the model goes, and the workspace's credential does the work
  without ever leaving the server — streamed or not, with `GET /v1/models` and `POST /v1/embeddings`
  beside it.
  
  Keys are minted per workspace, person, bot or nobody-in-particular, shown exactly once, narrowed to
  some brains if you like, given a budget over a day or a month, and revocable. Every call leaves a
  row in the ledger and says what it cost in `Perch-Cost-Usd`; a key that has spent its budget is
  refused with `402` before a provider is called. A brain can name others to fall back to when its
  provider will not answer.
- 50d8ab9: A provider can tell Perch when something happens. Make an endpoint for GitHub, Vercel or Clerk, paste
  its URL and its one-time secret into the provider, and every signed delivery becomes a card in the
  channel you wired it to — what happened, who did it, and a link. An unsigned delivery, or one signed
  with anything else, is refused and posts nothing; the same delivery twice is one card. Bots can wait
  for them too: a `webhook` trigger fires on a delivery and the bot answers in the card's own thread.
- fd812c8: Work items and the board. Work mode is no longer an empty state: a project has a board with one
  column per state, cards carrying `KEY-123`, and the two columns no other tracker has — **Running**
  and **Needs you**.
  
  Nobody drags a card into either. **Hand to an agent** opens a coding session on the item's project,
  and from then on the item follows it: running while the agent works, needs-you when it stops to
  ask, and in review when it finishes — never straight to done, because an agent finishing is not a
  person agreeing. A session opened from a card lets go of its runner when it is done, which is what
  moves the card.
  
  An item can start as a message in a channel and keep the thread it came from, so the work and the
  talking stay one thing. Bots hear `work_item.updated` over the Bot API with the identifier and
  what moved. And `work.create` and `work.update` complete Perch's own MCP server at `/mcp/perch`,
  so an agent outside can put something on the board and move it, naming items the way a person
  would: `NEST-12`.
  
  The board is live, works at 390 px, and asks for at most 200 items at a time — past that the
  useful answer is a filter rather than more cards.

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
