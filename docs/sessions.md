# Sessions and engines

An agent session (spec §3.3, §5.1) runs in a project on an engine: the person sends turns, the
engine answers with a stream of events (text, tool calls and results, permission requests, usage),
and Perch keeps the whole transcript. Task 1.8 delivers the interface, the lifecycle, persistence,
and replay; the adapters that drive real agents (ACP, OpenCode, the official CLIs) arrive with
tasks 1.9–1.11, and the session pane with 1.12. Design notes: ADR-0074.

## The session pane (task 1.12)

In Code mode with a project open, the sidebar's Sessions section lists the project's sessions
(newest first) and starts one (engine, and an agent or provider when the engine's default is not
wanted). A selected session (`?session=<id>` on the project route) opens the pane in the panel
(spec §4: panel = agent session; it pushes the main area on a phone):

- The transcript (`SessionTranscript` from `@perch/ui/session`): the person's turns, the agent's replies
  streamed as they arrive, tool cards collapsed to one line that open to arguments, output and
  diffs (`ToolCard`), permission prompts with Allow once / Always this session / Deny
  (`PermissionPrompt`), errors; virtualized, a live region for screen readers.
- The composer in session mode with a Plan/Build switch; Enter sends, Esc cancels a running
  round; a usage footer sums tokens and cost from `usage` events.
- Rename, fork, close. A fork (`POST /api/sessions/{s}/fork`) is a new session on the same
  project, engine, model, and mode with the transcript so far copied in (ADR-0078); the engine's
  own memory starts fresh until adapters fork natively.

Live updates come from the `session:<id>` topic: text deltas are applied as they arrive; every
other event triggers a replay of what is new after the last seq (the bus payloads carry ids, not
the full records).

## `@codebase` (task 2.17)

Type `@codebase` anywhere in a turn and Perch searches the project's codebase index for what you
asked, then puts the best six places — each with its file and lines — in front of your question on
the way to the engine. The transcript keeps what you typed: the context rides beside the turn, never
inside it. Details, and how to build the index, are in
[`repo-intelligence.md`](repo-intelligence.md).

## How hard it thinks (task 2.18)

The composer's **Thinking** control sets the session's reasoning level — `auto` (the agent's own
choice, where a session starts), `low`, `medium`, or `high` — and it is the session's from the next
round on. A quick action can name its own level for one turn without changing the session's.

The level travels to the runner with the turn. What an agent does with it depends on the agent: the
ACP adapter looks for the session config option ACP gives the category `thought_level`, or one whose
name says reason, effort, or thinking, and sets it to the nearest value the agent offers — matching
by name first (`low` also means `minimal`, `fast`, `off`) and by position otherwise. An agent that
advertises no such option ignores the level; Perch still records it, so the transcript says what was
asked for. The reasoning is ADR-0111.

## Quick actions (task 2.18)

The row above the composer is the project's own, from `.perch/project.json`: its run commands plus
any actions it declares. A prompt action sends its text as a turn in its own mode and level; a run
action is typed into the project's terminal. The same actions are in ⌘K, and firing one there with
no session open starts one. See [`projects.md`](projects.md).

## Which model a session runs on (task 1.15)

The **Brain** picker in the new-session form names the model: a brain is a provider, a model id,
and the credential to reach it, set up in workspace settings (see [Brains](./brains.md)). Leave it
on *The workspace default* and the session takes the brain marked **Default for code**, and failing
that the instance's `ENGINE_DEFAULT_MODEL`.

The **Agent** field is a different question: which program runs the engine — an ACP agent
(`gemini`, `codex`, `claude`, `goose`, `opencode`, `qwen`, `cline`) or, on the cli-harness lane,
which CLI. Leave it empty for the runner's default. Until brains landed the model's provider
doubled as that name; it does not any more (ADR-0081).

The brain's credential becomes environment on the engine's process and nowhere else —
`OPENAI_API_KEY` plus a base URL for a key, `OLLAMA_HOST` for an Ollama endpoint. A brain with no
credential runs on whatever the engine is already logged in to, which is how a Claude Code or Codex
subscription keeps working (spec §3.6 lanes B and C). A brain whose credential is personal can only
be used by the person who added it.

## Changes, checkpoints, and restore (task 1.13)

Before every turn the runner snapshots the project's working tree — tracked and untracked files,
ignores honored, `.git` untouched — as a parentless commit under
`refs/perch/checkpoints/<session>/<turn>`, recorded in `session_checkpoints` (ADR-0079). Nothing
about the person's branch, HEAD, or index changes, and a project that is not a repository simply
takes turns without checkpoints.

The pane's **Changes** tab (`DiffView` from `@perch/ui/diff`) shows either the whole session (the
first checkpoint against the tree as it is now) or one turn (its checkpoint against the next
turn's, or against now for the last turn). Each file lists its hunks, labelled "Hunk 2 of 3" for
screen readers, with line numbers in the gutter and adds and removes in the two semantic colors:

- **Accept** a hunk is a review decision: the agent's edit is already in the tree, so nothing is
  written. **Reject** sends that one hunk back to the runner as a reverse patch, so only those
  lines go back out. **Accept all** / **Reject all** answer every open hunk of a file, and
  **Open** puts the file in the editor beside the pane.
- Each decision carries the `@@` header the client saw. If the diff moved on since (another turn,
  an edit in the editor), the api answers 409 and the view reloads rather than patching blind.
- **Restore** on any turn in the transcript puts the project back to before that turn, after a
  confirmation: the files that differ are written from the checkpoint, the ones that did not exist
  then are deleted, and everything else is left alone. The restore lands in the transcript as a
  `restore` event, so a replay shows it.
- A fork inherits the checkpoints along with the transcript, so the turns it shows are the turns
  it can restore, and its next turn continues the numbering.
- A fenced code block in a reply gets an **Apply** button when its fence names a file
  (```` ```ts path=src/a.ts ````, `ts:src/a.ts`, or `title="src/a.ts"`); without one, Apply writes
  to the open editor tab.


```ts
interface Engine {
  readonly id: string; // acp, opencode, cli-harness, native, hermes, …
  readonly capabilities: { code: boolean; tools: boolean; subagents: boolean; streaming: boolean };
  createSession(p: CreateSessionParams): Promise<EngineSession>;
  send(sessionId, input: UserTurn, opts?: { mode?: "plan" | "build" }): AsyncIterable<EngineEvent>;
  respondPermission(sessionId, permissionId, answer: "allow" | "always" | "deny"): Promise<void>;
  cancel(sessionId): Promise<void>;
}
```

`EngineEvent` (packages/events) is the spec's union: `text {delta}`, `tool_call {id, name, args}`,
`tool_result {id, output, diff?}`, `permission {id, tool, args}`, `usage {input, output,
costUsd}`, `done`, `error {message}`. A round is one `send`: its events end with `done` or `error`.

Three things the package ships today:

| Export | What |
|---|---|
| `EngineRegistry` | The engines an api knows: a static engine, or a factory built per runner link (memoised, so a session's state lives in one object) |
| `FakeEngine` | A scripted engine for tests and demos: echoes the turn by default; a `permission` event in the script pauses the round until it is answered; `cancel` ends the round with `done` |
| `runnerEngine({ id, link })` | The api-side half of every runner-hosted adapter: `createSession`, `send`, `respondPermission`, `cancel` map onto §7.6 `session.create/send/permission/cancel`, and the runner's `session.event` notifications become the round's events |

Adding an engine: implement `Engine` (or `runnerEngine` for one hosted in the runner image) and
register it at boot (`boot({ engines: [...] })` or `engines.register(id, factory)`); a project's
`defaultEngine` (project.json) or the request's `engine` picks it.

## The ACP engine (`acp`, task 1.9)

The Agent Client Protocol is the engine contract (spec §3.3, ADR-0013): every runner hosts the
adapter (apps/runner/src/acp.ts), so any registry agent becomes an engine without code of its own.
The api registers `acp` as a `runnerEngine` bridge per runner; the runner spawns the agent over
stdio with the official SDK and maps its session updates onto EngineEvents:

| ACP | EngineEvent |
|---|---|
| `agent_message_chunk` (text) | `text {delta}` |
| `tool_call {toolCallId, title, rawInput}` | `tool_call {id, name: title, args: rawInput}` |
| `tool_call_update` completed / failed | `tool_result {id, output, diff?}`; `diff` content blocks become unified patches |
| `session/request_permission` | `permission {id, tool, args}`; the answer picks the agent's closest option (`allow` → allow_once, `always` → allow_always, `deny` → reject_once) |
| `usage_update` cost, `PromptResponse.usage` | `usage {input, output, costUsd}` per round (ACP counts are cumulative; the runner keeps the difference) |
| stop `end_turn` / `cancelled` | `done`; `refusal` → `error` |

Which agent runs is the session's `model.provider`: `gemini`, `codex`, `claude`, `goose`,
`opencode`, `qwen`, `cline` (the registry's launch commands, pinned as the registry pins them), or
any id from `PERCH_ACP_AGENTS`; `engine` or `default` means the runner's `PERCH_ACP_AGENT`
(default `gemini`). A binary on PATH wins over `npx`; an agent that is neither installed nor
fetchable fails the first turn with the reason. Perch's `plan`/`build` map onto the agent's own
modes when it has any (a mode whose id or name says "plan", otherwise the build-like one). Agents
read and write files through the client's fs capability, confined to the session's directory and
the runner's policy (`.git/**` stays read-only; writes announce `fs.changed`). The agent's
`stderr` goes to the runner's log; thoughts, plans, and `user_message_chunk` echoes are not stored
(the spec's union has no place for them yet). MCP servers for Perch's own tools ride the same
`session/new` request once the MCP gateway (task 1.17) exists.

## The OpenCode engine (`opencode`, task 1.10)

OpenCode's extras beyond ACP (spec §3.3, ADR-0031, ADR-0076): the runner starts `opencode serve`
per project directory and environment on first use (the pinned binary of the runner image, or
`opencode` on PATH for a local runner; a server runs on the credentials it was started with, so
another person or another brain is another server, ADR-0161) and drives it through
`@opencode-ai/sdk`; a Perch session is an OpenCode
session on that server. A turn runs as OpenCode's `build` or `plan` agent (Perch's mode), on the
session's `model` when it names one (`provider/model_id` → OpenCode's `providerID/modelID`; the
default is OpenCode's own configured model). The server's SSE stream becomes the transcript:

| OpenCode | EngineEvent |
|---|---|
| `message.part.updated`, text part | `text {delta}` (the SDK's delta, or the new tail of the part) |
| tool part pending/running | `tool_call {id: callID, name: tool, args: input}` |
| tool part completed / error | `tool_result {id, output, diff?}`; the edit and write tools' `filediff` and unified `diff` metadata become the FileDiff |
| `permission.updated` | `permission {id, tool: title, args: {type, pattern, …metadata}}`; the answer posts `once` / `always` / `reject` |
| `session.error` or the assistant message's `error` | `error {message}` (an aborted message is `done`) |
| the assistant message's `tokens` and `cost` | `usage {input, output, costUsd}` per turn |
| the session diff (`GET /session/{id}/diff`) | changes no tool reported this turn arrive as a `diff` tool call with the FileDiffs (subagents' edits included) |

Subagent sessions (OpenCode's child sessions) show through the parent's `task` tool part and their
permission requests are answered through the same route. `cancel` calls `session/abort`. Servers
with no session left are stopped after the idle period; provider credentials reach the server's
environment with brains (task 1.15); until then it uses OpenCode's own configuration on the runner.
The adapter (apps/runner/src/opencode.ts) is the only code touching OpenCode's API, and a version
bump reruns spike 0.4.3 first.

## The Hermes engine (`hermes`, task 3.8)

Hermes Agent is the runtime the Nest agents run on (spec §3.3). It speaks ACP itself — `hermes acp`
is an ACP server over stdio — so Perch runs it through the same client every registry agent uses.
What `engine: "hermes"` adds is the launch and two things that are Hermes' own:

- **Its own provider setup.** Hermes reads `~/.hermes/config.yaml` and `~/.hermes/.env`, and `~` is
  the person's own home volume (`/data/homes/<user>`). A Nous Portal or Codex subscription signed in
  with `hermes` in the terminal belongs to that person and serves only their sessions — spec §3.6's
  Lane B, kept by Perch not touching it. Perch never writes a credential into a Hermes session.
- **The model per run.** The session's brain travels as `HERMES_INFERENCE_MODEL`, which Hermes
  documents as the equivalent of `--model`. A session on the engine's own default (`provider:
  "engine"`) sets nothing and lets Hermes choose.

The runner image installs it pinned (see [dependencies](dependencies.md)); a runner that has it says
so in its capabilities, and one that does not refuses the session with a line saying what is missing.
`PERCH_HERMES_COMMAND` points at a checkout the PATH does not reach — `PERCH_HERMES_COMMAND="/opt/hermes/venv/bin/hermes acp"`.

Everything else — permissions, modes, diffs, usage, cancellation — is the ACP adapter's, described
above.

## The cli-harness engine (`cli-harness`, task 1.11, behind a flag)

Lane C of spec §3.6: the official CLIs in headless mode under the person's own login, on their own
machine. Off by default; an operator turns it on with `PERCH_FLAGS=cli_harness` (or an admin sets
the `flags` instance setting), and it only runs on a local runner (`perch runner connect`) or in
laptop mode, never on a hosted runner (ADR-0077). A session's `model.provider` names the CLI:

| CLI | A turn | Resumed as |
|---|---|---|
| `codex` | `codex exec --json --skip-git-repo-check -C <project> --sandbox workspace-write\|read-only <prompt>` | `codex exec … resume <thread_id> <prompt>` |
| `claude` | `claude -p --output-format stream-json --verbose --permission-mode acceptEdits\|plan <prompt>` | `claude -p … --resume <session_id> <prompt>` |

Perch's `plan` mode is Codex's read-only sandbox and Claude Code's `plan` permission mode. The
JSONL streams become EngineEvents: Codex `agent_message` → `text`, `command_execution` →
`tool_call`/`tool_result` (`shell`), `file_change` → `apply_patch` with the changed paths,
`mcp_tool_call` and `web_search` likewise, `turn.completed` → `usage` and `done`, `turn.failed` →
`error`; Claude Code assistant `text` blocks → `text`, `tool_use` → `tool_call` (an `Edit` or
`Write` carries its change, so the FileDiff is emitted with the call), `tool_result` → `tool_result`,
`result` → `usage` (with `total_cost_usd`) and `done` or `error`. The CLI's own session id resumes
the conversation on the next turn; cancel ends the process. The CLIs apply their own approval
policies, so this lane has no Perch permission prompts. Anthropic's terms keep Claude Code on this
lane off until confirmed (spec §3.6); nothing here proxies a subscription.

Running the acceptance against a real agent needs its credentials on the machine:

```
PERCH_ACP_TEST_AGENT=gemini GEMINI_API_KEY=… bun test apps/runner/test/acp.test.ts
PERCH_ACP_TEST_AGENT=codex OPENAI_API_KEY=… bun test apps/runner/test/acp.test.ts
```

CI runs the same flow against a registry-shaped agent (apps/runner/test/fixtures/acp-agent.ts).

## A session opened from a chat (task 3.7)

An agent bot's mention opens one of these (see [Agent bots](bots.md#agent-bots)). Such a session
carries the channel, the thread and the bot on its row, which is the whole of the coupling: the
session does not know it is being watched, and the thread hears about it by subscribing to the same
`session.permission_requested`, `session.done` and `session.error` events everything else does.

It runs as the bot's **owner** — a bot is not a person and has no runner — while the actor on every
event says which bot asked, so the audit log records both.

## A session that runs overnight (task 3.17)

Every session runs on the api rather than in a browser, so closing the tab has never stopped one.
What a **background session** adds is the other two thirds of §5.7's promise: somewhere for a run
nobody is watching to say what it is doing, and a rule about when that is allowed to reach a phone.

```
POST /api/workspaces/{ws}/projects/{p}/sessions/background
  {prompt, channel_id, thread_root_id?, engine?, agent?, worktree?}
  → {id, card_message_id}
```

A channel is required: a run with nowhere to report is a run nobody will ever read. What comes back
is the session and **one card**, which is then rewritten in place for the rest of the night —
never a message per event.

| The card says | While running | At the end |
|---|---|---|
| What it was asked | ✅ | ✅ |
| Where it got to — working, needs you, done, stopped | ✅ | ✅ |
| The tool it stopped to ask about | ✅ | — |
| Turns, tools, files changed, cost | ✅ | ✅ |
| How long it took | — | ✅ |
| The last thing it said | ✅ | ✅ |

It is **unattended** (ADR-0133), so it settles when its round goes quiet instead of holding a runner
open for a turn nobody is going to type. That is the finish line: the card's `done` and the
session's `ended` are the same moment.

### The testing loop (task 3.18)

`background.testLoop` in `.perch/project.json` turns on the loop §5.7 asks for: after a round that
**wrote something**, the project's own tests run on what it wrote, and a failure goes straight back
to the agent as the next turn.

```json
{ "run": { "test": "bun test" }, "background": { "testLoop": { "attempts": 2 } } }
```

"Its tests" is the first of `test`, `check`, `ci` or `verify` in the `run` map. They run where the
session works — its worktree when it has one (task 3.14), the project checkout otherwise — and the
agent is shown the command and the tail of what it said, with one instruction: fix it, and do not
change the tests to make them pass.

`attempts` (2 by default, 5 at most) is the bound. When it runs out the session stops at
**needs you** with what still fails on it, which is what the inbox and the background card read. An
agent that cannot fix what it broke will not fix it on the fifth try, and every try is somebody's
money.

A round that answered a question rather than writing anything is not tested, a round that errored
is not told off for it, and a test command that cannot be run at all is a warning in the log rather
than a failure the agent is blamed for. Leaving `testLoop` out, or setting `enabled: false`, turns
the whole thing off — running a suite after every turn is a choice a project makes, not a default
somebody discovers from their bill.

### What reaches a phone

`background.notify` in `.perch/project.json`:

| | Wakes a phone for |
|---|---|
| `needs_you` (the default) | a permission it is waiting on, or a failure |
| `always` | those, and the finish |
| `never` | nothing; the card speaks for itself |

One notification per state and one per session, so an evening of state changes replaces itself on
the lock screen rather than stacking up. A push that fails is a notification somebody misses, never
a run that fails.

## What is working right now (task 3.19)

Bots mode's sidebar opens on **Working now**: every coding session and every bot run in the
workspace that is actually going, oldest first, because the one that has been going longest is the
one worth looking at.

```
GET  /api/workspaces/{ws}/agents
POST /api/workspaces/{ws}/agents/{session|bot}/{id}/stop
```

Each row says what it is, what it is doing (**Working**, **Needs you**), which project or which
bot, and what it has cost so far, and links into the thing itself. The list is live: a session
changing status, a bot run starting or finishing, and a stop all land on the workspace topic, and
each of them means the list is out of date.

Beside every row is **Stop**, and it is the same button whatever the row is. For a session it
cancels the round the way the pane's Esc does; for a bot run it aborts the model call itself, and
the run ends saying it was stopped by a person rather than sitting `running` for ever. Stopping
something that finished a moment ago answers `{"stopped": false}` rather than an error — that is
the honest answer, and a race between a person's finger and an agent finishing is not a failure.

There is no third table keeping a register of what is running. `coding_sessions` and `bot_runs` are
where a working agent already records itself, and a register beside them would only be something
that can disagree with them.

## The lifecycle

```
idle ──turn──▶ running ──permission──▶ needs_you ──answer──▶ running ──done──▶ idle
                  │                                                  └──error──▶ error
                  └── cancel ──▶ (the engine's done) ──▶ idle
```

- One round per session at a time: a turn while one runs is `409 conflict`.
- A `permission` event parks the round in `needs_you`; `POST /permissions/{id}` answers it and the
  round continues. Answers are `allow` (once), `always` (this session), `deny`.
- `cancel` asks the engine to stop; the round ends with the engine's `done`.
- An engine that emits nothing for ten minutes mid-round is cancelled (a waiting permission does
  not count: people take their time).
- `error` from the engine, or a failure talking to it, marks the session `error` with the message;
  the next turn runs again.
- Cost accrues from `usage` events into `cost_usd`.

## Persistence and replay

Every event of a session, and the person's turn that started each round (`{type: "turn", text,
mode, userId}`), is a row of `session_events` with a `seq` that is monotonic per session: the api
bumps `coding_sessions.last_seq` in the same transaction as the insert, so two appenders cannot
collide and a reader can resume from any seq.

`GET /api/sessions/{s}/events?after_seq=N&limit=500` replays `{seq, ts, event}` rows after N and
reports `last_seq`. A client that lost its socket subscribes again and asks for what it missed.

## Live updates

Every event is republished on the bus and reaches the WS topic `session:<id>` (spec §7.2):
`session.turn`, `session.delta`, `session.tool_call`, `session.tool_result`,
`session.permission_requested`, `session.permission_answered`, `session.usage`, `session.done`,
`session.error`, and `session.status` (idle, running, needs_you, error, ended). The milestones
(`created`, `turn`, `permission_requested`, `done`, `error`, `status`) also reach `ws:<workspace>`
so lists and the inbox can follow without subscribing to every session. Subscribing to
`session:<id>` needs a membership in the session's workspace.

## REST

| Route | Does |
|---|---|
| `POST /api/workspaces/{ws}/projects/{p}/sessions` `{engine?, model?, mode?, title?, prompt?}` | Opens a session (`prompt` sends the first turn right away) |
| `GET /api/workspaces/{ws}/projects/{p}/sessions` | The project's sessions, newest first |
| `GET /api/sessions/{s}` | The session: status, model, turns, `last_seq`, cost |
| `POST /api/sessions/{s}/turns` `{text, attachments?, mode?}` | Starts a round → `202 {seq, session}` |
| `POST /api/sessions/{s}/permissions/{id}` `{answer}` | Answers a waiting permission |
| `POST /api/sessions/{s}/cancel` | Stops the running round → `{cancelled}` |
| `PATCH /api/sessions/{s}` `{title}` | Renames the session |
| `POST /api/sessions/{s}/fork` | A new session with the transcript, turn count, and checkpoints so far → `201 Session` (`forked_from_id` set) |
| `GET /api/sessions/{s}/events?after_seq&limit` | Replays the transcript |
| `POST /api/workspaces/{ws}/projects/{p}/inline-edit` `{path, selection, instruction, language?}` | Rewrites a selection for the editor's ⌘K → `{replacement, session_id}`; writes nothing (task 1.14) |
| `GET /api/sessions/{s}/checkpoints` | The checkpoint taken before each turn |
| `GET /api/sessions/{s}/diff?turn` | One turn's diff, or the whole session's → `{turn, from_turn, to_turn, files: FileDiff[]}` |
| `POST /api/sessions/{s}/diff/apply` `{turn?, decisions}` | Accepts and rejects hunks; rejects reverse-apply as one patch → `{files}` |
| `POST /api/sessions/{s}/checkpoints/{turn}/restore` | Puts the project back to before the turn → `{turn, git_ref, files}` |

Every route authorizes `sessions.read` / `sessions.create` / `sessions.update` in the session's
workspace (every member has them); strangers get 404. A session has a `kind`: `agent` for the ones
the Sessions list shows, `inline` for the editor's ⌘K lane, which is hidden and stays off the
workspace topic (ADR-0080). `model` defaults to
`{provider: "engine", model_id: "default"}`, meaning whatever the engine is configured with, until
model profiles (brains, task 1.15) choose one.

## Security

- Engines never see a Perch credential: a session carries the project's environment (task 2.13)
  and a model reference; provider keys reach engines through the gateway or the runner's own
  configuration, never through the api's transcript.
- Runner-hosted engines are driven through the runner protocol with a per-request capability
  token; a local runner only runs sessions for its owner (spec §3.2).
- Transcripts are workspace data: reading one needs a membership, and the audit log records who
  answered a permission.

## Tests

- `e2e/session.e2e.ts`: plan → build → permission → done through the pane on the laptop runner's
  fake ACP agent, then rename and fork; axe clean at both viewports.
- `packages/ui/src/components/session-transcript.ct.tsx`: the transcript's items, an opening tool
  card with its diff, an answered permission, virtualization of a long list; axe.
- `apps/web/test/transcript.test.ts`: the reducer from session events to transcript items.

- `packages/engines/test/fake.test.ts`: the fake engine's rounds, permissions, cancel, busy, the
  registry's memoisation.
- `packages/engines/test/runner-engine.test.ts`: the bridge maps calls onto `session.*` and turns
  notifications into a round.
- `apps/runner/test/acp.test.ts`: the adapter against the fixture agent (two turns, one permission,
  the diff, modes, cancel, deny, a failing prompt, fs confinement, refusals) and, with
  `PERCH_ACP_TEST_AGENT`, a real registry agent.
- `apps/api/test/sessions-acp.test.ts`: the same two turns through the REST routes and the
  in-process runner.
- `apps/runner/test/cli-harness.test.ts` and `apps/api/test/cli-harness.test.ts`: the harness
  against stand-ins printing the documented Codex and Claude Code streams (two turns with the
  thread or session resumed, tools and diffs, usage and cost, plan mode as the CLI's flag, a failing
  CLI, cancel, refusals on hosted runners), and the flag gate through the api.
- `apps/runner/test/opencode.test.ts`: the OpenCode adapter against a stand-in server speaking
  the SDK's endpoints and SSE stream (an edit with its diff, a side change as a diff tool call,
  plan mode, permissions, abort, a provider error, the refusal without a binary), and, with the
  real binary on PATH, `opencode serve` end to end.
- `apps/api/test/sessions.test.ts`: open → turn → replay with monotonic seqs and WS fan-out;
  permission parks and resumes with cost; one round at a time, cancel, an engine error and
  recovery; strangers, unknown engines, signed-out callers.
