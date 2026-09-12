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
