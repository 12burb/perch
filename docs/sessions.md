# Sessions and engines

An agent session (spec §3.3, §5.1) runs in a project on an engine: the person sends turns, the
engine answers with a stream of events (text, tool calls and results, permission requests, usage),
and Perch keeps the whole transcript. Task 1.8 delivers the interface, the lifecycle, persistence,
and replay; the adapters that drive real agents (ACP, OpenCode, the official CLIs) arrive with
tasks 1.9–1.11, and the session pane with 1.12. Design notes: ADR-0074.

## The Engine interface (`packages/engines`)

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
| `GET /api/sessions/{s}/events?after_seq&limit` | Replays the transcript |

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

- `packages/engines/test/fake.test.ts`: the fake engine's rounds, permissions, cancel, busy, the
  registry's memoisation.
- `packages/engines/test/runner-engine.test.ts`: the bridge maps calls onto `session.*` and turns
  notifications into a round.
- `apps/runner/test/acp.test.ts`: the adapter against the fixture agent (two turns, one permission,
  the diff, modes, cancel, deny, a failing prompt, fs confinement, refusals) and, with
  `PERCH_ACP_TEST_AGENT`, a real registry agent.
- `apps/api/test/sessions-acp.test.ts`: the same two turns through the REST routes and the
  in-process runner.
- `apps/api/test/sessions.test.ts`: open → turn → replay with monotonic seqs and WS fan-out;
  permission parks and resumes with cost; one round at a time, cancel, an engine error and
  recovery; strangers, unknown engines, signed-out callers.
