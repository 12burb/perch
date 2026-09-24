# Backups

A Perch holds the only copy of things nobody can reconstruct: the conversations, the work items,
the sessions, and the credentials that make the rest of it work. Task 4.4 is about being able to
get all of that back.

## What a backup is

A directory, with a name that sorts: `perch-2026-09-16T03-00-00Z`, readable by its owner only (mode
0700; the files in it 0600). A team instance and `perch backup` write the same format
(`perch-instance-backup`, ADR-0175).

| In it | What |
|---|---|
| `database.jsonl.gz` | every row Perch keeps, as JSON lines — a header, then one line per row, table by table |
| `files/` | the files directory (`PERCH_FILES_DIR`), as it was |
| `projects.tar.gz` | the project working copies, added by the supervisor (team mode) |
| `pglite.tar.gz` | laptop mode only: the PGlite data directory byte for byte, the fastest way back for `perch restore` |
| `master.key` | the vault key — **only** when `PERCH_BACKUP_INCLUDE_KEY=on` (or `perch backup --include-key`) |
| `manifest.json` | what is in here, how many rows and files, the schema the rows were read at, and the key's fingerprint |

The database dump is logical rather than a `pg_dump` or a copy of PGlite's directory, so **a laptop
backup restores into a team instance on Postgres and back again**. The schema comes from the
migrations the binary already carries; the backup carries the data. That also means the image needs
no database client binaries.

The dump's header records the schema its rows were read at (how many migrations had run). A backup
taken by one version restores into a later one: the rows are loaded at the schema they were written
at and then migrated forward, so the data migrations in between apply to them exactly as they would
have in an upgrade. A backup taken by a **newer** Perch is refused rather than loaded with the tables
and columns this build does not know silently dropped — restore it with that release or a later one.

The job queue's one-off jobs are not backed up: a week-old `supervisor.ensure` would start work
nobody asked for. Its schedules are — a bot's cron trigger lives nowhere else — and come back unlocked,
with their attempts at zero.

## Taking one

**Team mode.** Set a directory and a schedule; compose already mounts a `backups` volume for the
api and the supervisor:

```sh
PERCH_BACKUP_DIR=/data/backups   # a directory turns the nightly backup on
PERCH_BACKUP_CRON=0 3 * * *      # UTC; a night the instance was off is run when it comes back
PERCH_BACKUP_KEEP=7              # older ones are removed after each run
PERCH_BACKUP_INCLUDE_KEY=off     # on writes the vault key into every backup
```

The schedule is a cron row on Perch's own queue, so it survives restarts and needs no second
scheduler. Boot puts it in place again without moving a run that is already due, which is how a night
missed while the instance was off still runs when it comes back. A night that fails (a full disk)
retries a few times and then waits for the next night rather than stopping the schedule; the error
stays on the row. A failure to remove an older backup is logged and never costs the one just taken.
By hand, either way:

```sh
docker compose exec api bun apps/api/src/index.ts backup
curl -X POST https://perch.example.com/api/admin/backup -b cookies.txt   # the instance's admin only
```

**Laptop mode.** Stop `perch dev` (and the desktop app) first, then:

```sh
perch backup ./perch-backup-today
perch backup ./perch-backup-today --include-key   # the vault key too; see below
```

One Perch runs on a data directory at a time: `perch dev`, `perch demo` and the desktop app hold
`~/.perch/perch.lock` while they run, and `perch backup`, `perch restore` and `perch doctor`'s database
check refuse (doctor reports) rather than opening a database another process has open — PGlite lets a
second process open the same files, and whichever closes last overwrites the other's work (ADR-0175).
A lock left by a process that is gone is taken over.

That directory holds both copies of the database: `pglite.tar.gz`, which is this data directory
byte for byte, and `database.jsonl.gz`, which restores anywhere.

## The vault key

Everything a credential holds is encrypted with `PERCH_MASTER_KEY` (in laptop mode, the generated
`~/.perch/master.key`). A backup **does not** include that key by default — in either mode: it
records a fingerprint of it instead, so a restore can say plainly whether the key it has is the key
those rows were encrypted with.

That means a backup alone cannot open anything — and that **you must keep the key somewhere else**.
A backup without its key restores every message, work item and project, and every credential in it
stays shut. `PERCH_BACKUP_INCLUDE_KEY=on` puts the key in the directory when that trade is not the
one you want; then the backup unlocks everything in it, and belongs wherever you keep secrets.

## Restoring

Into an **empty** instance, which is what a restore is for. Perch refuses to restore on top of rows
that are already there rather than merging two histories:

```sh
# team mode: a database nothing has run on yet (create it; do not start the api against it first),
# and the same PERCH_MASTER_KEY
docker compose exec -e DATABASE_URL=postgres://perch:…@postgres:5432/perch_restore \
  api bun apps/api/src/index.ts restore /data/backups/perch-2026-09-16T03-00-00Z

# laptop mode (a laptop backup, or a team one: it has no exact copy, so the dump is used)
perch restore ./perch-backup-today --data-dir ~/.perch-restored
perch restore ./perch-backup-today --portable   # the logical dump, even when the exact copy is there
```

`restore` runs before the api boots, so the migrations run up to the schema the backup was taken at,
the rows go in, and the rest of the migrations run after them. A database an api has already
migrated past an older backup's schema is refused with that explanation: drop it, create it again,
and restore into that. The rows go in with foreign keys switched off for the load — a backup is a
set of rows that was already consistent, and some of them (a message that is its own thread root)
cannot be inserted in any order at all with the keys on.

A backup that carried the key (`master.key`) puts it in place in laptop mode. Otherwise the restore
says whether the key it has matches the backup's fingerprint — and, for a laptop restore into a fresh
directory, that the original `master.key` belongs there before `perch dev` starts.

Afterwards the same people sign in with the same passwords, because their accounts came back with
everything else.

## The drill

A backup nobody has restored is a hope. CI restores one on every push, in both modes:

- **laptop** — `apps/cli/test/laptop.test.ts` takes a backup and restores it into a fresh data
  directory, twice: once from the exact copy and once from the portable dump; restores a laptop
  backup into a team instance and a team backup into a laptop data directory; and checks that
  nothing opens a data directory `perch dev` is running on. It runs on Linux, macOS and Windows.
- **team** — the compose smoke takes a backup through `/api/admin/backup`, then the workflow
  restores it into an empty Postgres database beside the live one and counts what came back.
- **the whole loop** — `apps/api/test/backup.test.ts` backs up one instance, restores it into a
  second empty one, and checks that the person signs in, the channel's message is there, the file
  is beside it, and a vault-encrypted credential still decrypts.

## What is not here yet

Backups to S3 rather than a local directory (the bucket settings exist for files, not for backups),
encryption of the backup itself, and a restore that merges rather than replaces. The retention is a
count, not a policy: seven directories, not "a daily for a week and a monthly for a year".
