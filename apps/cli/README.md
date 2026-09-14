# @perch/cli

The `perch` binary (spec §2): laptop mode and the deployment helpers. Built per platform with
`bun build --compile` by the release workflow (0.15); from source, `bun apps/cli/src/index.ts <command>`.

| Command | What |
|---|---|
| `perch dev [--port 3000] [--host 127.0.0.1] [--data-dir ~/.perch]` | api + web + the in-process runner on PGlite; the master key is generated on first run; open the URL to finish the setup wizard |
| `perch doctor [--json]` | checks Bun, the data dir, the PGlite database and migrations, the master key, the port, the web build, git, docker; exit 1 when a required check fails |
| `perch backup [<dir>]` | writes a backup directory: `pglite.tar.gz` (PGlite's own dump), `files/`, `master.key`, `manifest.json`; stop `perch dev` first |
| `perch restore <dir> [--force]` | restores a backup into the data dir (refuses to overwrite without `--force`) |
| `perch init --public-url https://… [--preview-domain …]` | writes `.env`, `docker-compose.yml`, and a Caddyfile for docker compose (team mode) |

`perch runner connect` (task 1.3) and `perch migrate --to-compose` come later. The in-process runner
registers and heartbeats today and answers `ports.list`; the PTY, engines, fs, git, and previews arrive
with Phase 1 and light up the same link (ADR-0059).

```sh
bun run --filter @perch/web build       # once, so perch dev has a web app to serve
bun apps/cli/src/index.ts dev           # http://127.0.0.1:3000
bun apps/cli/src/index.ts doctor
bun apps/cli/src/index.ts backup ./backup-1
```
