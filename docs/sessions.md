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
per project directory on first use (the pinned binary of the runner image, or `opencode` on PATH
for a local runner) and drives it through `@opencode-ai/sdk`; a Perch session is an OpenCode
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
| `GET /api/sessions/{s}/checkpoints` | The checkpoint taken before each turn |
| `GET /api/sessions/{s}/diff?turn` | One turn's diff, or the whole session's → `{turn, from_turn, to_turn, files: FileDiff[]}` |
| `POST /api/sessions/{s}/diff/apply` `{turn?, decisions}` | Accepts and rejects hunks; rejects reverse-apply as one patch → `{files}` |
| `POST /api/sessions/{s}/checkpoints/{turn}/restore` | Puts the project back to before the turn → `{turn, git_ref, files}` |

Every route authorizes `sessions.read` / `sessions.create` / `sessions.update` in the session's
workspace (every member has them); strangers get 404. `model` defaults to
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
