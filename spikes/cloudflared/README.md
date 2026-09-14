# Spike 0.4.10 — cloudflared profile

**Pass criterion:** an OAuth callback and a webhook reach the api through the tunnel.

**Outcome (ADR-0038): deferred.** A Cloudflare tunnel needs an account and a tunnel token, which this
environment and the repository's CI secrets do not have. This directory ships the `tunnel` compose profile
(the shape used by `deploy/docker-compose.yml`) and `check.ts`, which sends a callback-shaped GET and a
webhook-shaped POST to `PERCH_PUBLIC_URL` and requires both to reach the api. `.github/workflows/spikes.yml`
runs it when `TUNNEL_TOKEN` and `PERCH_SPIKE_PUBLIC_URL` are set.

```sh
TUNNEL_TOKEN=... PERCH_PUBLIC_URL=https://perch.example.com \
docker compose -f spikes/cloudflared/docker-compose.yml --profile tunnel up -d && bun spikes/cloudflared/check.ts
```

## Fallback: Tailscale Serve or Funnel

Until the tunnel is verified, the documented alternative for a stable HTTPS URL behind NAT is Tailscale:

- `tailscale serve --bg 3000` exposes the api on the tailnet with a Tailscale-issued certificate
  (`https://<machine>.<tailnet>.ts.net`); set `PERCH_PUBLIC_URL` to that origin. Vendors whose callbacks must
  come from the public internet need Funnel instead.
- `tailscale funnel --bg 3000` publishes the same origin to the internet for OAuth callbacks and webhooks.

Both keep the callback URL stable, so the CIMD document and every connector callback derive from one
`PERCH_PUBLIC_URL` exactly as with Caddy or cloudflared.
