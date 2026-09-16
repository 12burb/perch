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
| `perch runner connect <api-url> --token prt_…` | joins this machine to a Perch as one of your environments |
| `perch connectors check <dir>` | puts connector manifests through the harness before an instance loads them |
| `perch upgrade [--check] [--force] [--require-signature]` | replaces this binary with the newest release, after checking it against the release's `SHA256SUMS` and, where cosign is installed, the signature over them |

`perch migrate --to-compose` comes later.

Installing a built binary rather than running from source is one line —
`curl -fsSL https://raw.githubusercontent.com/12burb/perch/main/install.sh | sh`, or `irm
https://raw.githubusercontent.com/12burb/perch/main/install.ps1 | iex` on Windows — and
[`docs/install.md`](../../docs/install.md) covers the package managers, what is verified before
anything is written, and `perch upgrade`.

```sh
bun run --filter @perch/web build       # once, so perch dev has a web app to serve
bun apps/cli/src/index.ts dev           # http://127.0.0.1:3000
bun apps/cli/src/index.ts doctor
bun apps/cli/src/index.ts backup ./backup-1
```

## `perch runner connect`

`perch runner connect <api-url> --token prt_… [--name <name>] [--kind local|remote]` joins this machine
to a Perch as one of your environments (spec §3.2). The token comes from the workspace's Environments
page ("Connect a machine"), which shows it once; the runner serves only you. Runs until Ctrl-C and
reconnects when the api restarts. `docs/runners.md` has the details.
