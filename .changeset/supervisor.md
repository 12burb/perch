---
"@perch/api": minor
"@perch/db": patch
"@perch/events": patch
---

The supervisor entrypoint runs hosted runners: one container per workspace on demand (or one shared
container with `PERCH_RUNNER_MODE=shared`) from the runner image, with CPU, memory, and pid limits, the
homes and projects volumes, and a connect token; idle containers are stopped after
`PERCH_RUNNER_IDLE_MINUTES`. Migration 0004 lets a runner row belong to every workspace and records
`idle_since`.
