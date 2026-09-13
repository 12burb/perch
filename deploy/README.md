# deploy/

The team-mode deployment (spec §3.1, §8): four containers by default.

| File | What |
|---|---|
| `docker-compose.yml` | caddy (80/443), api, supervisor (the only service with the Docker socket), postgres (pgvector); profiles `local` (ollama) and `tunnel` (cloudflared) |
| `Caddyfile` | `{$PERCH_PUBLIC_URL}` → `api:3000` |
| `Caddyfile.preview` | the same plus `*.{$PERCH_PREVIEW_DOMAIN}` with the DNS-challenge wildcard certificate |
| `Dockerfile.api` | `oven/bun` build (Node for Vite) → slim runtime, non-root, entrypoints `api` \| `worker` \| `supervisor` |
| `Dockerfile.runner` | the runner base: Ubuntu 24.04, Bun, Node LTS, Python + uv, git, ripgrep, tmux, Playwright Chromium (the agent and CLIs arrive with Phase 1) |
| `Dockerfile.caddy` | Caddy built with a `caddy-dns` module (`CADDY_DNS_MODULE`, default cloudflare) |

```sh
perch init --dir ./perch --public-url https://perch.example.com   # writes .env, docker-compose.yml, Caddyfile
cd perch && docker compose up -d                                   # then open the URL: the setup wizard
```

Build locally: `docker build -f deploy/Dockerfile.api -t perch-api .` from the repo root. Images are
published to GHCR on tags by the release workflow (task 0.15), multi-arch, signed with cosign, SBOM attached.
See [`../docs/deploy.md`](../docs/deploy.md).
