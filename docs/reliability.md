# The reliability bar

Numbers, not feelings (task 4.10; spec §10's Phase 4 line "load, upgrade and chaos tests with
published targets"). Three drills, each with a target written down, all three runnable by anybody:

```sh
bun run reliability                  # all three, at the published size
bun run reliability -- --only load   # one of them
bun run reliability -- --sessions 20 # a smaller wave
```

`bun run check` runs the same drills at a size the gate can afford (twelve sessions instead of a
hundred), so a regression fails a push rather than a nightly nobody reads.

## Load: a hundred sessions at once

One instance, one project, a hundred sessions opened in the same moment, each with a turn to answer.

| What | Target | Measured |
|---|---|---|
| Sessions that opened and answered | 100 of 100 | 100 of 100 |
| The whole wave, open to last answer | under 60 s | **7.3 s** |
| Opening one more while it holds a hundred, p95 | under 3 s | **40 ms** (p50 16 ms) |
| A turn settling under the wave, p95 | under 30 s | **7.3 s** |
| Memory the instance grows by | under 768 MB | **+153 MB** |

The engine is in-process for this drill, on purpose. What it measures is Perch under concurrency —
the api, the database, the bus, the session service, the WS fan-out — and not how fast somebody
else's CLI starts. The number that says the most is the third: with a hundred sessions held, the
next person through the door still gets a session in about sixteen milliseconds.

Measured on the machine this was written on (8 cores, PGlite in memory). The targets have room for
a slower one; the point of a target is that it fails when something regresses, not that it is tight.

## Upgrade: no data loss

Two shapes of upgrade, because operators do both.

| What | Target | Measured |
|---|---|---|
| A database one migration behind runs the pending migration | applies exactly what is pending | 1 of 40 |
| Every row written before the upgrade is still there | all of them | workspaces, users, channels: all 1 |
| A backup restores into a database that was migrated a moment ago | every row | 22 of 22, across 10 tables |

The first is the ordinary case: new code, old data, on the same machine. The second is the one that
moves machines as well as versions — Perch's own logical backup (`docs/backups.md`) written by one
instance and loaded into a database that has only just had the migrations run on it.

## Chaos: a runner killed mid-turn

A session is opened on a runner, a turn that takes five seconds is sent, and the machine the agent
was on disappears while it is still talking.

| What | Target | Measured |
|---|---|---|
| The turn really was running when its runner died | running | running |
| The session stops saying it is running | not running, within 20 s | **error after 8.1 s** |
| The workspace takes a new runner and opens a new session | yes | yes |

Eight seconds is the silence window plus the grace after it: the round is cancelled when the engine
has said nothing for `silenceMs` (ten minutes by default, three seconds in the drill), and if the
engine cannot even be *cancelled* — which is what a dead runner means — Perch ends the round itself
five seconds later. The session says "the agent stopped answering and its runner could not be
reached" instead of claiming to be running for ever.

That last part is a fix this drill produced: before it, a session whose runner died stayed `running`
until somebody deleted it, because the watchdog asked a machine that was no longer there to stop and
had no other plan.

## What the drills do not cover

- **The engines themselves.** A real agent CLI is a process on a runner; its startup time and its
  memory are its own. The load drill deliberately measures Perch.
- **Postgres under load.** The drills run on PGlite in memory, which is what CI has. The api's own
  test suite runs against a real Postgres service container on every push (`docs/ci.md`), so the
  queries are exercised there.
- **A multi-machine instance.** One api process, one runner. Several of each is the next bar.
