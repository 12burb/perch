# Deploying Perch (team mode)

Spec §3.1 and §8. Four containers by default: `caddy` (TLS, reverse proxy, WebSocket passthrough),
`api` (HTTP + WS, the jobs worker, the built web app), `supervisor` (the only container with the Docker
socket; creates runner containers on demand from Phase 1), and `postgres` (`pgvector/pgvector`).
Profiles: `local` adds Ollama, `tunnel` adds cloudflared.

## 1. Write the deployment

```sh
perch init --dir ./perch --public-url https://perch.example.com
# optional: --preview-domain preview.example.com --dns-provider cloudflare --dns-token <token>
# optional: --telemetry (off by default; the wizard asks too)
```

`perch init` writes:

| File | Contents |
|---|---|
| `.env` (mode 600) | `PERCH_PUBLIC_URL`, a generated `PERCH_MASTER_KEY` (32 random bytes, base64), a generated `POSTGRES_PASSWORD`, `PERCH_IMAGE_TAG` pinned to the CLI's release, `PERCH_TELEMETRY`, and commented optional settings |
| `docker-compose.yml` | the pinned compose file from `deploy/` |
| `Caddyfile` | `{$PERCH_PUBLIC_URL}` → `api:3000`, plus the `*.{$PERCH_PREVIEW_DOMAIN}` wildcard block when a preview domain was given |

Every variable is documented in [`../.env.example`](../.env.example). `DATABASE_URL` is derived by compose
from `POSTGRES_PASSWORD`; set it explicitly to use an external Postgres (16+ with `vector` and `citext`).

Compose mounts `./connectors` next to these files at `/data/connectors`, read-only. Put
`<id>/manifest.yaml` files there and set `PERCH_CONNECTORS_DIR=/data/connectors` to add a service
Perch does not ship, or to correct one it does — see [connections](./connections.md). Run
`perch connectors check ./connectors` before you restart.

## 2. Start

```sh
cd perch
docker compose up -d
docker compose logs -f api      # "perch api listening" once migrations ran
```

DNS must point the public hostname at the host; Caddy obtains the certificate automatically. With a
preview domain, `*.<domain>` needs a wildcard DNS record and the DNS-challenge token (`CADDY_DNS_PROVIDER`,
`CADDY_DNS_TOKEN`; the image is built with the matching `caddy-dns` module, see `deploy/Dockerfile.caddy`).

## 3. Finish setup in the browser

Open the public URL. The setup wizard (once per database) asks for the admin account, the first workspace,
confirms `PERCH_PUBLIC_URL`, and shows the telemetry checkbox (off by default; [`telemetry.md`](telemetry.md)
lists every field). Sign-ups are refused until the wizard completes, so nobody else can claim the admin
seat. Afterwards the admin signs in, invites the team from workspace settings, and members join with the
invite link.

## Upgrades, backups, previews

- Upgrade: change `PERCH_IMAGE_TAG` in `.env`, `docker compose pull && docker compose up -d`; migrations run
  on boot under an advisory lock (ADR-0039).
- Backups: set `PERCH_BACKUP_DIR=/data/backups` (the compose file already mounts the volume for the
  api and the supervisor) and a nightly one is taken at `PERCH_BACKUP_CRON`, keeping
  `PERCH_BACKUP_KEEP` of them. `docker compose exec api bun apps/api/src/index.ts backup` takes one
  now; the same entrypoint's `restore <dir>` loads one into an empty database. The vault key is
  fingerprinted rather than included unless `PERCH_BACKUP_INCLUDE_KEY=on`, so keep
  `PERCH_MASTER_KEY` somewhere else — [`backups.md`](backups.md) has the rest.
- Previews without a wildcard domain use path mode (`/p/<workspace>/<port>/`, ADR-0036).
- Local models: `docker compose --profile local up -d` starts Ollama at `http://ollama:11434`.
- Cloudflare tunnel: set `TUNNEL_TOKEN` and `docker compose --profile tunnel up -d`.

## Laptop mode: the same product, no Docker

`perch dev` runs the api, the built web app, and an in-process runner on PGlite under `~/.perch`.
That is not a demo mode: everything Phase 1 built works there, which is what task 1.21 pins down.
Projects, the file tree and editor, search, the terminal, sessions on any engine with permissions
and per-turn diffs, ⌘K, brains, connections, the MCP gateway, previews with HMR, and the Git panel
with its written commit messages — all of it, from one process, with `curl | sh` and no daemon.

The differences are the ones the architecture forces, and no others:

- **One runner, this machine.** No supervisor, no containers, no per-workspace isolation: a project
  runs beside your own files with your own tools. That is the point of laptop mode, and the reason
  the cli-harness engine is allowed here and refused on a hosted runner.
- **Previews are path mode** unless you set `PERCH_PREVIEW_DOMAIN` (`perch dev --preview-domain`),
  and they are reached directly rather than tunnelled, because the runner is this process.
- **No wildcard certificate, no Caddy, no queue worker in another container.** Jobs run in the same
  process.

`apps/cli/test/parity.test.ts` drives all of it through a real `perch dev` on every push, on Linux,
macOS, and Windows.

## Images

| Image | Built from | Base |
|---|---|---|
| `ghcr.io/12burb/perch-api` | `deploy/Dockerfile.api` | `oven/bun:1.3.11` (build, with Node 24.21.0 for Vite) → `oven/bun:1.3.11-slim` |
| `ghcr.io/12burb/perch-runner` | `deploy/Dockerfile.runner` (repo root context) | `ubuntu:24.04` + Bun 1.3.11, Node 24.21.0, uv 0.12.13, Playwright 1.62.1 Chromium, the runner agent at `/opt/perch` |
| `ghcr.io/12burb/perch-caddy` | `deploy/Dockerfile.caddy` | `caddy:2.11.4` (+ `caddy-dns/<provider>`) |
| postgres | upstream | `pgvector/pgvector:0.8.6-pg16` |
| ollama, cloudflared | upstream | `ollama/ollama:0.34.0`, `cloudflare/cloudflared:2026.9.1` |

Multi-arch (amd64, arm64), cosign-signed, SBOM attached by the release workflow (task 0.15). Renovate keeps
the pins current. A local build: `docker build -f deploy/Dockerfile.api -t perch-api .` from the repo root.

The api image's runtime tree holds only the api workspace, the packages it links, the web build, and
their production dependencies (a fresh `bun install --production --omit=peer --filter @perch/api` in the
build stage, ADR-0062); the base image gets Debian security updates at build time. The compose smoke in
CI scans the image with Trivy and fails on fixed HIGH/CRITICAL findings, so anything that lands in the
image has to be needed at runtime.

The runner image carries the runner agent (`apps/runner`, its packages, and production dependencies at
`/opt/perch`, built like the api's runtime tree) and starts it as the entrypoint; the supervisor sets
`PERCH_API_URL` and `PERCH_RUNNER_TOKEN` (`docs/runners.md`).
