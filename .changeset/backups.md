---
"@perch/api": minor
"@perch/cli": minor
"@perch/db": minor
---

Backups you can trust. A Perch now takes one on a schedule — `PERCH_BACKUP_DIR` turns it on,
`PERCH_BACKUP_CRON` says when, `PERCH_BACKUP_KEEP` says how many to keep — and `/api/admin/backup`
takes one now and lists what is there. A backup is a directory: the database as a gzipped
JSON-lines dump, the files beside it, the project volumes added by the supervisor, and a manifest.

The dump is Perch's own format rather than `pg_dump` or PGlite's data directory, so **a laptop
backup restores into a team instance on Postgres, and back**. Restoring is "migrate, then load",
which also means a backup restores into a later Perch:

```sh
docker compose exec api bun apps/api/src/index.ts backup
docker compose exec -e DATABASE_URL=…/perch_restore api bun apps/api/src/index.ts restore /data/backups/<id>
perch backup ./today && perch restore ./today --portable
```

The vault key is **not** in a backup unless you ask (`PERCH_BACKUP_INCLUDE_KEY=on`): its
fingerprint is, so a restore says plainly whether the key you have is the key those rows were
encrypted with. Restoring into an instance that already has rows is refused rather than merged.

CI restores a backup on every push, in both modes — laptop on Linux, macOS and Windows, and team
into an empty Postgres database beside the live one.
