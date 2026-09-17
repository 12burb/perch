# @perch/api

## 0.3.0

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
- ab5b891: The agent's eyes. While a project's preview is actually serving, every session on it is handed a
  Playwright MCP server spawned on the runner beside the agent — so it can navigate, snapshot, click
  and screenshot the page it is working on, where the page is.
  
  Set `PERCH_PLAYWRIGHT_MCP` to the command that runs it; unset means off. Which build matches the
  browser in your runner image is yours to pin, which is why this is a command rather than a version
  Perch chose for you. A session with nothing to look at gets no browser.
- 4c5251d: Agent presence. Bots mode's sidebar now opens on **Working now**: every coding session and every bot
  run in the workspace that is actually going, oldest first, each saying what it is doing and what it
  has cost, and each linking into the thing itself. It is live — a session changing status, a run
  starting or finishing, a stop — with a poller behind it.
  
  Beside every row is **Stop**, and it is one button whatever the row is: a session's round is
  cancelled, and a bot's model call is aborted so the run ends saying a person stopped it rather than
  sitting there. Stopping something that just finished answers "nothing to stop" rather than an error.
- 5f1a486: The audit log grew up. **Settings → Audit log** now shows who did what and when in a table that
  narrows by action, by actor (a person, a bot, a runner, or Perch itself) and by a range of days,
  and **Export CSV** takes the same view away as a file — with fields that cannot turn into formulas
  when the spreadsheet opens.
  
  How long the log is kept is now a setting: `PATCH /api/admin/settings` with
  `audit_retention_days` (0, the default, keeps everything), pruned nightly an hour after the backup
  so nothing is deleted before it has been copied. `GET /api/admin/audit` is the same query across
  every workspace, for the account the instance was set up with.
  
  And a test that reads every route: `apps/api/test/authorized.test.ts` checks that each one decides
  whether the caller may do what they asked — the policy check, a Bot API scope, or the instance
  guard — and that anything without one is named with the reason it needs none.
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
- 8362875: Connectors are files. Point `PERCH_CONNECTORS_DIR` at a directory of `<id>/manifest.yaml` and those
  providers appear in Connections at the next boot, with the paste lane, the sign-in lane, the test
  call, the MCP server and the webhook scheme all read off the file — a connector can now be added,
  or a broken built-in one corrected, without a fork and without waiting for a release.
  
  Six more ship in the box: Slack, Stripe, Linear, Notion, Sentry and Discord, alongside GitHub,
  Vercel, Supabase and Clerk. Making them work meant the manifest could say more: `token_scheme: raw`
  for a provider that wants the token without `Bearer` in front of it, `headers:` for one that needs
  its own on every call, and `webhook.timestamp_prefix` for Stripe's `t=<ts>,v1=<hex>`, where the
  signed timestamp rides inside the signature header. `webhook.id_header` and `event_header` are now
  optional, because a provider that puts neither in a header — Slack, Stripe — is normal.
  
  `perch connectors check <dir>` is the harness. It parses a manifest and then exercises what it
  claims: a delivery signed by its own scheme must verify, the same delivery with a byte changed must
  not, and somebody else's secret must not. It says when a lane does not add up, and it says out loud
  when a provider signs nothing at all, which three of them really do. Every connector in this repo
  goes through it in CI.
  
  OAuth tokens now refresh. A connection whose access token expires within the next minute is swapped
  before the call that needed it goes out, on the same app it was made with; one nobody is using is
  left alone. A refresh the provider refuses marks the connection Not accepted rather than failing a
  moment later with something less useful.
- df6e9aa: Direct tweaks in the inspector. Select an element in the preview and the panel gives you its text
  and its classes; typing in either changes the page as you type. **Write to source** then makes it
  true in the repository, and shows you the diff.
  
  There is no model anywhere near it: the element already carries where it was written, so the edit is
  a pure function over that file and that position. It refuses whatever it cannot do exactly — a
  `className` that is an expression, an element holding more than text, a position the file has moved
  on from — with the reason, rather than guessing at a plausible edit.
- d2ea19a: The rest of the §5.5 seed connectors: Google Workspace, Jira, Cloudflare, Railway, Netlify, HeyGen
  and X, each one's lanes, test call, account field and webhook signature read off that provider's own
  documentation. Seventeen ship now, and `perch connectors check` passes on all of them.
  
  Webhook verification grew three schemes to match what those providers actually do: **Ed25519**, so
  Discord's deliveries can be verified at last (paste Discord's public key into Perch rather than a
  Perch secret into Discord), a **shared secret in a header** for Cloudflare and Google — which proves
  who sent a delivery and not what they sent, and says so — and Netlify's **signed JWT**, checked
  against the body's digest.
- 57eb0aa: The Hermes engine. A session can run on Hermes Agent (`engine: "hermes"`), the runtime the Nest
  agents use. Hermes speaks ACP itself, so Perch runs it through the same client as any other agent:
  permissions, modes, diffs, usage and cancellation all behave as they do everywhere else.
  
  What is Hermes' own stays Hermes': it reads its provider setup from the person's own home volume, so
  a Nous Portal or Codex subscription signed in with `hermes` in the terminal serves only that
  person's sessions and never reaches Perch's vault. The session's brain is passed as
  `HERMES_INFERENCE_MODEL`; a session on the engine's own default lets Hermes choose. The runner image
  installs it pinned, and a runner without it says which binary is missing.
- 602fa1f: Runner-local MCP servers. A project can ship its own tools — a command in the repository — and
  Perch runs them where the project is: the runner spawns the process, the api speaks MCP down the
  stream it answers with, and `/mcp/{id}` looks exactly like a connection's server. A bot attaches
  one by naming it in its spec. No port, no token, no vault entry: the gate is the workspace, the
  spec, and the runner's own policy on the command.
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
- abed13a: The Nest. A roster of agents you can install as a team — Birbus, who runs it, and four specialists:
  Dawn (code), Julius (finding things out), Paige (writing) and Kimi (what the data says). Workspace
  settings → Bots → The Nest, or `POST /api/workspaces/{ws}/nest`.
  
  Each joins through one of two doors. A Bot API agent becomes an external bot with a token shown once
  on the install, and runs wherever it already runs; a Hermes agent becomes an agent bot on the
  `hermes` engine, which Perch runs on a project's runner. What comes out either way is ordinary bots:
  edit them, install them in channels, delete them.
  
  Installing one grants it nothing. Kimi expects a Supabase connection and says so, but an admin still
  has to grant it on the Connections page — until then the agent is refused.
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
- 4c77c5f: Perch is an MCP server. Point any MCP client at `https://<your perch>/mcp/perch` with an api token
  as its bearer, and an agent running anywhere — on your laptop, in a cron job, inside an IDE — can
  list the channels it can see, search the chat, post as you, open a coding session on a project,
  and call a tool on one of your connections. The gateway has always put other people's tools in
  front of Perch; this is Perch's own.
  
  The token's scopes are what it may do, and a tool it has no scope for is not in `tools/list` at
  all, so an agent plans with the doors it actually has. **Settings → Security** now offers every
  scope rather than just read/write/admin, shows the MCP URL beside them, and starts a new token at
  read alone instead of read and write — a token should begin with the least it can.
  
  A tool that will not run answers with the reason rather than failing the call, because an agent
  can read a reason and try something else. `work.create` and `work.update` arrive with work items
  themselves.
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
- 3ae0e07: The Pull Requests page. Code mode's drawer has a **Pull requests** tab: the connection's open pull
  requests, and any one of them with its inline comments — each on the file and line it was left on —
  the reviews so far, and what the checks made of the head commit. Approve, request changes, or
  comment, straight back to the provider.
  
  And **Ask the agent to address it**: a session opens on the pull request's own branch and its first
  turn is the review itself, every comment with its file and line. It is told to change the code and
  not to reply in the pull request, because the push is what answers a review.
- 0f0e198: Traces and cost per task. With `PERCH_OTLP_ENDPOINT` set, every session round, bot run, model call,
  tool call and runner RPC is a span on your own collector — ids and small facts only, never a prompt
  or a file. Without it, nothing changes and nothing is loaded. A finished work item now says what it
  cost and where its time went, on the card and at `GET /api/work-items/{id}/cost`.
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
- 6b96260: A worktree per task. An item handed to an agent gets a git worktree of its own, on a branch named
  `perch/key-123` beside the project checkout, so three agents can work one repository at once and
  none of them sees another's half-finished edits. The isolation is git's rather than Perch's, and
  the branch each agent is on is already the branch a pull request wants.
  
  Closing an item gives the directory back and keeps the branch — a checkout is a place to work, not
  the work. A project with no commit to branch from has no worktree to give, and the session works in
  the project directory rather than refusing to start.
  
  Sessions now report their `worktree`, `branch` and `work_item_id` over REST, so "which branch is
  this agent on" stops being a question you answer by reading a diff.

### Patch Changes

- 0939d63: A bot may only use the connections it was granted. `tools.call` now checks the grant where the call
  happens: a connection nobody granted to this bot is refused, a grant that lists tools refuses
  anything outside the list by name, and both refusals are audited. The audit also records that a
  **bot** made the call — it used to say a person had, whoever called.
- e0fa6ce: The demo workspace no longer starts a dev server behind the setup wizard.
  
  Seeding a project is one thing; leaving a process listening on a port nobody asked about, as part of
  finishing a wizard, is another — and on Windows it outlived the instance that started it. The seed
  now creates the project and stops there, and the welcome message says which button starts it.
  `perch demo`, where somebody did ask to see a preview running, still starts one.
  
  The runner also closes its own copy of the dev server's log handle after handing it to the child: it
  had no use for it, and on Windows it was enough to make the project's directory undeletable.
- 6c38559: The Hub: one page for the connectors, bots, skills and starter stacks this build ships, at
  `/<workspace>/hub` or ⌘K → Hub. Filter by kind, search, and press Install — a bot is created in the
  workspace (and put in a channel if you say which), a template becomes a project, a skill lands on a
  bot you name, and a connection takes you to the Connections card, because signing in is yours to do.
  Everything offered came from the same commit as the Perch offering it; there is no remote registry.
- 5b807c8: The launch bar: four numbers that say whether a stranger can actually get in — `docker compose up`
  to a signed-in admin, `curl | sh` to a binary on the path, `perch dev` to an instance serving, and
  arriving to an agent's first pull request in under ten minutes. Each is measured where that path
  runs and asserts its own budget there, so a regression fails the job that caused it. `bun run
  launch` prints the bar; `docs/launch.md` says what the ten minutes contains.
- 1762cca: Tracing resolves its tracer per call instead of keeping one from import time, and hands every span
  whose parentage matters its parent rather than relying on an ambient context. Nothing changes for
  an instance with tracing off; an instance with it on gets the same trace whether or not a context
  manager is installed.
- 10caeec: A bot handle is only taken if somebody in the same workspace has it. `@dawn` means whoever is
  called that here, so a person called Dawn in another workspace no longer stops a workspace from
  having a bot called `@dawn` — which had been failing the Nest install for anyone whose instance
  had grown past one workspace.
- e367481: The Phase 3 gate: `docs/phase-3-report.md` says what shipped, where the exit criterion runs, and
  what was decided along the way, and `TASKS.md` now carries Phase 4 — the gateway at `/v1`, budgets,
  installers, backups, the docs site, templates, security scanning, the reliability bar and the launch
  bar.
- fe75ba9: Three fixes the Phase 3 end-to-end run found. A session in a worktree now runs in the directory
  `worktree.create` made rather than in a path built by joining the branch name on, so an agent given
  its own checkout no longer fails with "worktree … does not exist" — every branch with a slash in
  it, which is all of them. Preflight no longer fails a page over the favicon the browser asked for
  and nobody wrote. And a race refuses two entries from the same engine, which would have been two
  entrants in one worktree, instead of failing halfway through starting them.
- Updated dependencies [82cb101]
- Updated dependencies [ab5b891]
- Updated dependencies [4c5251d]
- Updated dependencies [b579c03]
- Updated dependencies [f519b64]
- Updated dependencies [31b4dba]
- Updated dependencies [8362875]
- Updated dependencies [df6e9aa]
- Updated dependencies [d2ea19a]
- Updated dependencies [602fa1f]
- Updated dependencies [fe0a09f]
- Updated dependencies [c3fe0bd]
- Updated dependencies [abed13a]
- Updated dependencies [5549cfd]
- Updated dependencies [a5fe8a8]
- Updated dependencies [7ccdff3]
- Updated dependencies [714f396]
- Updated dependencies [cf4673b]
- Updated dependencies [3ba2508]
- Updated dependencies [00f1986]
- Updated dependencies [c2a9d67]
- Updated dependencies [3fdf6c1]
- Updated dependencies [53b90b0]
- Updated dependencies [4c68089]
- Updated dependencies [50d8ab9]
- Updated dependencies [fd812c8]
  - @perch/db@0.2.0
  - @perch/events@0.2.0
  - @perch/bots@0.2.0
  - @perch/connect@0.2.0
  - @perch/connectors@0.2.0
  - @perch/inspector@0.2.0
  - @perch/templates@0.1.0
  - @perch/jobs@0.1.0
  - @perch/gateway@0.2.0
  - @perch/policy@0.2.0
  - @perch/bus@0.0.3
  - @perch/engines@0.1.1
  - @perch/hub@0.1.1

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
