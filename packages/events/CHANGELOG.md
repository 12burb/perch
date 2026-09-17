# @perch/events

## 0.2.0

### Minor Changes

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
- 53b90b0: The testing loop. Put `background.testLoop` in `.perch/project.json` and the project's own tests run
  after any round that wrote something — in the session's worktree, or its checkout — and a failure
  goes straight back to the agent as the next turn, with the command and what it said. It gets two
  tries by default (five at most); after that the session stops at **needs you** with what still
  fails, where the inbox and the background card already look.
  
  A round that only answered a question is not tested, a round that errored is not told off for it,
  and leaving `testLoop` out leaves everything as it was.

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
- fb30b24: Agents can use a connection's tools without ever holding its credential. Every connection whose
  provider has an MCP server is now one itself, at `/mcp/{connectionId}`: a session is handed that
  URL and a token Perch minted for it, and Perch attaches the provider's real credential on the way
  out. A grant's allow-list decides which tools a session may call — a refusal never reaches the
  provider — and every call is audited with the tool, the caller, and a hash of its arguments. A
  connection may override its provider's MCP URL for a self-hosted host, the way it already can for
  the REST API.
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
- 0d33a89: Runners answer the fs (list, read, write, stat, ripgrep-backed search), git (status, diff, commit,
  push, branch, worktrees), ports, and exec methods, every call through a policy hook with built-in
  rules (destructive commands, publishes, force pushes, git internals, exec confined to the projects
  root); the Environments list shows each runner's listening ports and the api answers them live.
- cc5c90d: Sessions: the Engine interface with a fake engine and a runner-hosted bridge, the
  coding_sessions/session_events tables, and api routes to open a session in a project, send turns,
  answer permissions, cancel, and replay the transcript from a seq; every event fans out live on the
  session's WS topic.
- f0ff645: The terminal: Code mode's drawer opens a shell on the project's runner (xterm.js), per person,
  inside tmux where the machine has it; a reload or a reopened drawer comes back to the same shell
  with its scrollback, and file paths printed in the output open in the editor. Runners answer
  `pty.open/input/resize/close` and carry terminal data over `/api/runner/stream/{token}` sockets.

### Patch Changes

- de84546: Local runners: the Environments page lists a workspace's runners with live status, "Connect a machine"
  mints a connect token shown once inside the `perch runner connect` command, owners and admins remove
  runners, and `perch runner connect <url> --token …` joins a machine as one of your environments.
- ea81bde: The runner control channel (spec §7.6): runners connect to `/api/runner` with a connect token, register,
  heartbeat, and answer api requests that carry per-request capability tokens; the runner image now runs
  the runner agent as its entrypoint (`PERCH_API_URL`, `PERCH_RUNNER_TOKEN`).
- a438fc6: The supervisor entrypoint runs hosted runners: one container per workspace on demand (or one shared
  container with `PERCH_RUNNER_MODE=shared`) from the runner image, with CPU, memory, and pid limits, the
  homes and projects volumes, and a connect token; idle containers are stopped after
  `PERCH_RUNNER_IDLE_MINUTES`. Migration 0004 lets a runner row belong to every workspace and records
  `idle_since`.

## 0.0.1

### Patch Changes

- 027121b: Core packages: the spec §7 contracts as Zod (bus event catalog, WS protocol, runner JSON-RPC, EngineEvent, error shape); an in-process bus with per-topic replay; a Postgres job queue with SKIP LOCKED claims, backoff, cron, and crash recovery; envelope encryption with rotation. Adds the jobs table (migration 0002).
- 45c4eee: Laptop mode (task 0.14): `perch dev` runs the api, the web app, and an in-process runner on PGlite under
  `~/.perch`; `perch doctor` checks the machine and the data directory; `perch backup` and `perch restore`
  round-trip the PGlite data, files, and master key as a backup directory. `RunnerLink` in `@perch/events`
  and the api's runner registry (`GET /api/health` now reports `checks.runners` and `mode`) are the seam
  the hosted and local runners plug into next.
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
