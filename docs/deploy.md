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
- Backups: `perch backup` / `perch restore` arrive with task 0.14; until then `pg_dump` the `postgres`
  service and copy the `files` volume.
- Previews without a wildcard domain use path mode (`/p/<workspace>/<port>/`, ADR-0036).
- Local models: `docker compose --profile local up -d` starts Ollama at `http://ollama:11434`.
- Cloudflare tunnel: set `TUNNEL_TOKEN` and `docker compose --profile tunnel up -d`.

## Images

| Image | Built from | Base |
|---|---|---|
| `ghcr.io/12burb/perch-api` | `deploy/Dockerfile.api` | `oven/bun:1.3.11` (build, with Node 24.21.0 for Vite) → `oven/bun:1.3.11-slim` |
| `ghcr.io/12burb/perch-runner` | `deploy/Dockerfile.runner` | `ubuntu:24.04` + Bun 1.3.11, Node 24.21.0, uv 0.12.13, Playwright 1.62.1 Chromium |
| `ghcr.io/12burb/perch-caddy` | `deploy/Dockerfile.caddy` | `caddy:2.11.4` (+ `caddy-dns/<provider>`) |
| postgres | upstream | `pgvector/pgvector:0.8.6-pg16` |
| ollama, cloudflared | upstream | `ollama/ollama:0.34.0`, `cloudflare/cloudflared:2026.9.1` |

Multi-arch (amd64, arm64), cosign-signed, SBOM attached by the release workflow (task 0.15). Renovate keeps
the pins current. A local build: `docker build -f deploy/Dockerfile.api -t perch-api .` from the repo root.
