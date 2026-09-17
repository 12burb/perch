---
"@perch/api": minor
"@perch/db": minor
---

The reliability bar: a hundred sessions at once, an upgrade with no data loss, a runner killed
mid-turn.

`bun run reliability` runs three drills against published targets (`docs/reliability.md`), and CI
runs it on every push. A hundred sessions open and answer in 7.3 seconds, and with all hundred held
the next session still opens in about sixteen milliseconds. A database one migration behind upgrades
with every row intact, and a backup restores into a database that was migrated a moment ago.

The chaos drill found a real bug and this release fixes it: a session whose runner died stayed
`running` for ever. The watchdog cancelled the round by asking the engine to stop, and an engine
whose runner is gone cannot be asked anything. Perch now ends such a round itself and the session
says "the agent stopped answering and its runner could not be reached" instead of claiming to be
working.
