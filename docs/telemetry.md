# Telemetry

Telemetry is **off by default** (`PERCH_TELEMETRY=off`). The setup wizard shows a visible checkbox; nothing is
sent unless an admin turns it on. This page is the complete list of what an opted-in instance sends. Adding
a field is a pull request to this file first.

## The ping

Once a day, an opted-in instance sends one JSON document over HTTPS to the Perch project's telemetry
endpoint (published in `apps/api` when it exists; until then the setting has no effect).

| Field | Example | Why |
|---|---|---|
| `instance_id` | `01926a1e-…` | A random UUID generated on first run and stored in `instance_settings`. Not derived from hardware, hostnames, or users. Reset by deleting the setting. |
| `version` | `0.4.2` | Which releases are in use. |
| `os` | `linux` | Platform support priorities. |
| `arch` | `arm64` | Same. |
| `mode` | `compose` \| `laptop` | Team vs single-binary usage. |
| `users_bucket` | `1` \| `2-5` \| `6-20` \| `21-100` \| `100+` | Rough instance size. Never an exact count. |
| `engines_enabled` | `["acp", "opencode"]` | Which engines matter. |
| `local_models` | `true` | Whether any local model endpoint is configured. Never which model. |

## Never sent

Message content, prompts, transcripts, file names, repository names, URLs, email addresses, user names,
workspace names, API keys, tokens, model names, IP addresses beyond what the HTTPS request inherently
exposes, or anything else not in the table above.

## Verify it yourself

`PERCH_LOG_LEVEL=debug` logs the exact document before it is sent. The sending code is the only network call
the api makes to a Perch-project host, and it is grep-able as `telemetry.ping` in `apps/api`.

## Traces (task 3.22)

Traces are a different thing from the ping, and they go somewhere different: to **your** collector,
never to the Perch project. Set `PERCH_OTLP_ENDPOINT` to an OTLP/HTTP endpoint and the api exports
spans to it; leave it unset — the default — and there is no SDK, no exporter and no background
flush.

The shape is one trace per session round and per bot run:

| Span | Opened by | Carries |
|---|---|---|
| `session.round` | a turn sent to an engine | `perch.engine`, `perch.turn`, `perch.mode`, the ids, and `perch.input_tokens` / `perch.output_tokens` / `perch.cost_usd` once the engine reports usage |
| `tool.<name>` | a `tool_call` event, closed by its result | `perch.tool`, `perch.files_changed` when the tool changed files |
| `bot.run` | a bot answering anything | `perch.trigger`, `perch.bot_id`, and the run's own usage and cost |
| `bot.model` | the model call inside a run | `perch.model_id`, `perch.provider` |
| `runner.<method>` | every api→runner RPC, wrapped where the registry hands out the link | `rpc.method`, `perch.runner_id`, and whichever ids the call carries |

Nesting is what makes them worth having: "the agent took four minutes" is never the useful answer,
and "three of them were one `fs.search` on a repository nobody had indexed" is.

**Attributes are ids and small facts only.** No prompt, no message text, no file contents, no tool
arguments, no credentials — the same rule the log lines follow (spec §9.1). A tool's *name* is a
span name; a tool's *arguments* are the conversation, and the conversation is not telemetry.

## What a work item cost

Cost does not need a collector. Every session records its own usage, so a work item's bill is its
sessions added up:

```
GET /api/work-items/{id}/cost
  → {cost_usd, elapsed_ms, working_ms, turns, sessions: [{id, engine, status, cost_usd, turns, elapsed_ms}]}
```

A finished card on the board shows it. `elapsed_ms` is the item's own clock — from when it was made
to when its last session ended — and `working_ms` is the time an agent was actually running, which
is **larger** when a race ran three engines at once. Nothing is stored: a second ledger of what an
item cost is a second answer that can disagree with the first.
