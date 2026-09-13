# Spike 0.4.8 — Caddy wildcard

**Pass criterion:** a DNS-challenge wildcard certificate issues for `*.preview.<domain>` in CI.

**Outcome (ADR-0036): deferred; the fallback is the default.** Issuing a certificate needs a real domain and
a DNS provider token, neither of which exists in this environment or in the repository's CI secrets yet.
This directory ships what the check needs: the `Caddyfile` shape (public host → `api:3000`; `*.<preview
domain>` with `tls { dns … }`), `Dockerfile.caddy` (Caddy built with the cloudflare, route53, digitalocean,
and hetzner DNS modules; `deploy/Dockerfile.caddy` is the shipped copy), a compose stack with an api stub,
and `check.ts`, which reads the served certificate's SANs. `.github/workflows/spikes.yml` runs the stack and
the check when `CADDY_DNS_TOKEN` and `PERCH_SPIKE_PREVIEW_DOMAIN` are set.

Until then previews run in path mode (`/p/<workspace>/<port>/`), which is what spec §8 prescribes whenever
`PERCH_PREVIEW_DOMAIN` is unset.

```sh
bun test spikes/caddy-wildcard        # file presence; `caddy validate` when a caddy binary exists
PERCH_PUBLIC_HOST=perch.example.com PERCH_PREVIEW_DOMAIN=preview.example.com \
CADDY_DNS_PROVIDER=cloudflare CADDY_DNS_TOKEN=... PERCH_ACME_EMAIL=you@example.com \
docker compose -f spikes/caddy-wildcard/docker-compose.yml up --build -d && bun spikes/caddy-wildcard/check.ts
```
