# @perch/runner

## 0.2.0

### Minor Changes

- ab5b891: The agent's eyes. While a project's preview is actually serving, every session on it is handed a
  Playwright MCP server spawned on the runner beside the agent — so it can navigate, snapshot, click
  and screenshot the page it is working on, where the page is.
  
  Set `PERCH_PLAYWRIGHT_MCP` to the command that runs it; unset means off. Which build matches the
  browser in your runner image is yours to pin, which is why this is a command rather than a version
  Perch chose for you. A session with nothing to look at gets no browser.
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
- 925ac47: The four official agent CLIs now ship inside the runner image, pinned: Codex
  (`@openai/codex`), Claude Code (`@anthropic-ai/claude-code`), Gemini CLI (`@google/gemini-cli`) and
  OpenCode (`opencode-ai`), plus the `codex-acp` and `claude-agent-acp` bridges. A session starts on
  any of them without fetching anything first.
  
  One file pins them — `deploy/agents.json` — and the image installs from it and then carries it at
  `/opt/perch/agents.json`, so a runner reports the four and their versions in
  `capabilities.versions` rather than guessing. A runner with no manifest (a laptop joined with
  `perch runner connect`) asks each CLI itself and reports only what is really there.
  
  CI builds the image's `agents` layer on every push and checks that each CLI reports the version the
  manifest pins.
- 53b90b0: The testing loop. Put `background.testLoop` in `.perch/project.json` and the project's own tests run
  after any round that wrote something — in the session's worktree, or its checkout — and a failure
  goes straight back to the agent as the next turn, with the command and what it said. It gets two
  tries by default (five at most); after that the session stops at **needs you** with what still
  fails, where the inbox and the background card already look.
  
  A round that only answered a question is not tested, a round that errored is not told off for it,
  and leaving `testLoop` out leaves everything as it was.

### Patch Changes

- 1235207: The runner now finds a Chromium that Playwright downloaded, on every platform it downloads one for.
  A laptop that has run `playwright install chromium` needs nothing else for preflight or the agent's
  eyes, and CI stopped depending on one hard-coded cache path — Playwright's layout is per platform
  (`chrome-linux64` on linux-x64, `chrome-linux` on arm64), and the one that exists wins.
- e0fa6ce: The demo workspace no longer starts a dev server behind the setup wizard.
  
  Seeding a project is one thing; leaving a process listening on a port nobody asked about, as part of
  finishing a wizard, is another — and on Windows it outlived the instance that started it. The seed
  now creates the project and stops there, and the welcome message says which button starts it.
  `perch demo`, where somebody did ask to see a preview running, still starts one.
  
  The runner also closes its own copy of the dev server's log handle after handing it to the child: it
  had no use for it, and on Windows it was enough to make the project's directory undeletable.
- fe75ba9: Three fixes the Phase 3 end-to-end run found. A session in a worktree now runs in the directory
  `worktree.create` made rather than in a path built by joining the branch name on, so an agent given
  its own checkout no longer fails with "worktree … does not exist" — every branch with a slash in
  it, which is all of them. Preflight no longer fails a page over the favicon the browser asked for
  and nobody wrote. And a race refuses two entries from the same engine, which would have been two
  entrants in one worktree, instead of failing halfway through starting them.
- 3256729: The cli-harness waits for a CLI's output to end, not just for its process to exit. A `codex exec
  --json` turn whose last JSONL lines were still in the pipe when the process went became a bare
  `done` with no tools, no text and no usage — reliably enough on Windows to fail CI.
- Updated dependencies [82cb101]
- Updated dependencies [ab5b891]
- Updated dependencies [4c5251d]
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
  - @perch/events@0.2.0

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
- 3af96e8: The cli-harness engine, behind the `cli_harness` feature flag (off by default): on a local runner
  or in laptop mode, a session can run Codex (`codex exec --json`) or Claude Code
  (`claude -p --output-format stream-json`) under the person's own login, with the CLIs' streams as
  the transcript and their own sessions resumed turn after turn. Feature flags arrive with it:
  `PERCH_FLAGS` and the `flags` instance setting.
- b144df4: Review what an agent changed: a Changes view in the session pane shows the diff of one turn or of
  the whole session, with labelled hunks you accept or reject one at a time, Accept all / Reject all
  per file, and Open to jump to the file. Rejecting a hunk takes just those lines back out. Every
  turn now takes a checkpoint of the project first, so any turn can be restored from the transcript,
  and a code block in a reply can be applied to the file its fence names.
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
- 76ae435: The OpenCode engine: runners start `opencode serve` per project (the pinned binary ships in the
  runner image) and drive it through the SDK, so a session runs OpenCode's build or plan agent with
  tool calls, the edit tools' diffs, permission prompts, usage, and cancellation flowing through the
  session routes.
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
- ea81bde: The runner control channel (spec §7.6): runners connect to `/api/runner` with a connect token, register,
  heartbeat, and answer api requests that carry per-request capability tokens; the runner image now runs
  the runner agent as its entrypoint (`PERCH_API_URL`, `PERCH_RUNNER_TOKEN`).
- 0d33a89: Runners answer the fs (list, read, write, stat, ripgrep-backed search), git (status, diff, commit,
  push, branch, worktrees), ports, and exec methods, every call through a policy hook with built-in
  rules (destructive commands, publishes, force pushes, git internals, exec confined to the projects
  root); the Environments list shows each runner's listening ports and the api answers them live.
- f0ff645: The terminal: Code mode's drawer opens a shell on the project's runner (xterm.js), per person,
  inside tmux where the machine has it; a reload or a reopened drawer comes back to the same shell
  with its scrollback, and file paths printed in the output open in the editor. Runners answer
  `pty.open/input/resize/close` and carry terminal data over `/api/runner/stream/{token}` sockets.

### Patch Changes

- d711cbc: Checkpoints, restores, and rejected hunks no longer rewrite a file's line endings on Windows,
  where git converts LF to CRLF by default. The snapshot lane now runs with that conversion off, so
  what a checkpoint captured is what a restore puts back.
- 1647095: Fixes two engine adapter bugs found by CI: a cli-harness turn could not be cancelled when the
  previous CLI process exited after the next turn had started (its late exit cleared the new turn's
  state), and file paths reported by a CLI or agent through a symlinked project directory (macOS
  `/private/var` for a `/var` project) came back as `../../…` instead of project-relative. Turn state
  now lives on the turn itself, and reported paths are taken through the real ancestors of both
  sides, including files that do not exist yet.
- de84546: Local runners: the Environments page lists a workspace's runners with live status, "Connect a machine"
  mints a connect token shown once inside the `perch runner connect` command, owners and admins remove
  runners, and `perch runner connect <url> --token …` joins a machine as one of your environments.
- e940d4f: Clone a repository through a service you have already connected: pick "A connected service" under
  Authentication in Code mode and Perch mints a token for that one clone. Connections can also point
  at a service you host yourself — a GitHub Enterprise Server, say — with the new API base field.
  
  A runner can be told about an `opencode serve` that is already running (`PERCH_OPENCODE_URL`)
  instead of starting one per project.
  
  Phase 1's exit criterion now runs on every push as one Playwright spec, four times over: clone via
  GitHub, ask for a change, watch it in Preview from a phone, review the diff, commit, open a pull
  request — on a key, on Ollama, through OpenCode, and through ACP.
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
- Updated dependencies [5f61320]
- Updated dependencies [c4e921c]
- Updated dependencies [f3aefb9]
- Updated dependencies [eb5cdaa]
- Updated dependencies [52af50e]
- Updated dependencies [8d7d282]
- Updated dependencies [ea81bde]
- Updated dependencies [0d33a89]
- Updated dependencies [9b25388]
- Updated dependencies [3764521]
- Updated dependencies [cc5c90d]
- Updated dependencies [365bdc5]
- Updated dependencies [a438fc6]
- Updated dependencies [f0ff645]
  - @perch/events@0.1.0
  - @perch/db@0.1.0

## 0.0.1

### Patch Changes

- 45c4eee: Laptop mode (task 0.14): `perch dev` runs the api, the web app, and an in-process runner on PGlite under
  `~/.perch`; `perch doctor` checks the machine and the data directory; `perch backup` and `perch restore`
  round-trip the PGlite data, files, and master key as a backup directory. `RunnerLink` in `@perch/events`
  and the api's runner registry (`GET /api/health` now reports `checks.runners` and `mode`) are the seam
  the hosted and local runners plug into next.
- eaa6104: Phase 0 spikes with recorded outcomes: bun-pty replaces node-pty on Bun (ADR-0029); the ACP SDK, OpenCode SDK, PGlite with pgvector, the QuickJS sandbox, better-auth with the Drizzle adapter, and the preview tunnel over an outbound runner socket are verified; dockerode, the Caddy wildcard, and cloudflared are gated on CI resources (ADR-0030..0038).
- e05fb7a: Resolve and pin every dependency named in the spec (docs/dependencies.md), with ADR-0019..0028 for the non-obvious picks; commit the lockfile.
- 3ab9ae7: Scaffold the monorepo: Bun workspaces, Turborepo, Biome, strict TypeScript, Changesets, Renovate, PR and issue templates, the AGPL-3.0 / MIT license split, and repository invariant tests.
- Updated dependencies [027121b]
- Updated dependencies [45c4eee]
- Updated dependencies [62de53e]
- Updated dependencies [1d93dfb]
  - @perch/events@0.0.1
