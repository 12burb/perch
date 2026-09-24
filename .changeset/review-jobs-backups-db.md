---
"@perch/jobs": patch
"@perch/db": patch
"@perch/api": patch
"@perch/cli": patch
"@perch/desktop": patch
---

Backups, the job queue and the laptop data directory no longer lose data quietly (ADR-0175).

- Only one Perch opens a laptop data directory at a time: `perch dev`, `perch demo` and the desktop
  app hold `~/.perch/perch.lock`, and `perch backup`, `perch restore` and `perch doctor` refuse (doctor
  reports who holds it) instead of opening a database another process is writing.
- `perch backup` writes the same format a team instance does, so a laptop backup restores into the
  compose stack and a team backup restores with `perch restore`. The vault key is left out unless
  `--include-key` or `PERCH_BACKUP_INCLUDE_KEY=on` asks for it; the manifest records its
  fingerprint, and backup directories are readable by their owner only.
- A backup records the schema its rows came from: a backup from a newer Perch is refused, and an
  older one is loaded at its own schema and migrated forward so data migrations apply. The team
  `restore` command now runs before the api boots, into a database nothing has migrated yet.
- Bot schedules come back with a restore. Large tables are dumped by key instead of by offset, a
  full disk ends a backup with its error instead of hanging it, and a failure to prune an old backup
  no longer deletes the new one.
- A nightly job that fails every retry runs again the next night, a night missed while the instance
  was off runs when it comes back, and a database blip no longer ends the worker process.
- A workspace or project has exactly one policy document, even when two saves race; duplicates
  left by earlier races are removed (the newest is kept).
- A reindex drops the chunks of files deleted since the last one.
- A closing laptop database waits at most five seconds for a wedged query.
