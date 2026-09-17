# @perch/bots

## 0.2.0

### Minor Changes

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
- abed13a: The Nest. A roster of agents you can install as a team — Birbus, who runs it, and four specialists:
  Dawn (code), Julius (finding things out), Paige (writing) and Kimi (what the data says). Workspace
  settings → Bots → The Nest, or `POST /api/workspaces/{ws}/nest`.
  
  Each joins through one of two doors. A Bot API agent becomes an external bot with a token shown once
  on the install, and runs wherever it already runs; a Hermes agent becomes an agent bot on the
  `hermes` engine, which Perch runs on a project's runner. What comes out either way is ordinary bots:
  edit them, install them in channels, delete them.
  
  Installing one grants it nothing. Kimi expects a Supabase connection and says so, but an admin still
  has to grant it on the Connections page — until then the agent is refused.
- 714f396: Orchestrators can split a job. A bot with `orchestrator: true` and the `fan_out` tool takes a whole
  plan in one call — who does what, and whether to wait for all of them, the first, or a quorum — and
  the thread gets a plan card showing each specialist, what they were asked, and what they may spend,
  rewritten in place as answers land.
  
  What is left of the thread's budget is divided evenly among the bots actually tagged, and each share
  is that bot's alone: the first to run can no longer spend what the others were promised. Every reply
  comes back to the orchestrator at once, wrapped as untrusted, for it to fold into one answer.
  
  A bot without the flag that calls `fan_out` is told so, and nobody is tagged.
- 3fdf6c1: A bot can live in a repository. Put `bots/<handle>/bot.yaml` next to a `SYSTEM.md` and a `skills/`
  folder in any project, and Perch reads it: the bot appears in the workspace, answers where it is
  installed, and keeps its persona and skills in version control where they can be reviewed like
  anything else. Pushing from the Git panel reloads them; the panel's Reload bots button does the
  same after a pull, and says which directory Perch could not read.
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

### Patch Changes

- Updated dependencies [82cb101]
- Updated dependencies [b579c03]
- Updated dependencies [f519b64]
- Updated dependencies [31b4dba]
- Updated dependencies [fe0a09f]
- Updated dependencies [c3fe0bd]
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
  - @perch/gateway@0.2.0

## 0.1.0

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
- 7ffcb04: The Forge: make a bot without writing anything. Settings → Bots has six starting points — Grok
  Newsroom, GPT Helpdesk, Claude Reviewer, Local Llama, 12birb Editor, GAM3 TALK Show Notes — and
  picking one fills the form in: what it is called, what people type after an @, what it is told,
  which brain it runs on, what it may spend, which tools it has and what sets it off. Each bot then
  shows the channels it is in, what it has cost, a pause switch, and a test chat for asking it
  something without saying it in a channel. Bots can also carry skills now — a named way of doing
  something, with its instructions — which go in front of the model with the persona.
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

### Patch Changes

- Updated dependencies [378589c]
- Updated dependencies [9246f90]
- Updated dependencies [ea3b91b]
- Updated dependencies [ed9f649]
- Updated dependencies [347ce60]
- Updated dependencies [9c29082]
- Updated dependencies [3318f0e]
- Updated dependencies [7ffcb04]
- Updated dependencies [2918dc6]
- Updated dependencies [a837eea]
- Updated dependencies [3417ea3]
- Updated dependencies [f39b87d]
- Updated dependencies [0985050]
- Updated dependencies [f3aefb9]
- Updated dependencies [eb5cdaa]
- Updated dependencies [52af50e]
- Updated dependencies [8d7d282]
- Updated dependencies [9b25388]
- Updated dependencies [3764521]
- Updated dependencies [cc5c90d]
- Updated dependencies [365bdc5]
- Updated dependencies [a438fc6]
  - @perch/db@0.1.0
  - @perch/gateway@0.1.0

## 0.0.1

### Patch Changes

- e05fb7a: Resolve and pin every dependency named in the spec (docs/dependencies.md), with ADR-0019..0028 for the non-obvious picks; commit the lockfile.
