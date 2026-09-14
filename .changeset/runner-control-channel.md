---
"@perch/runner": minor
"@perch/api": patch
"@perch/events": patch
---

The runner control channel (spec §7.6): runners connect to `/api/runner` with a connect token, register,
heartbeat, and answer api requests that carry per-request capability tokens; the runner image now runs
the runner agent as its entrypoint (`PERCH_API_URL`, `PERCH_RUNNER_TOKEN`).
