---
"@perch/api": patch
"@perch/api-client": patch
"@perch/web": patch
"@perch/cli": patch
"@perch/ui": patch
---

Deploy (task 0.13): `deploy/Dockerfile.api` (Bun runtime, Vite build under Node, non-root, `api | worker |
supervisor`), `deploy/Dockerfile.runner` (the Ubuntu 24.04 runner base), `deploy/Dockerfile.caddy`
(Caddy with a DNS-challenge module), the pinned `docker-compose.yml` with the `local` and `tunnel`
profiles, the Caddyfiles, `.env.example`, `perch init` (writes `.env` with generated secrets, the compose
file, and the Caddyfile), and the setup wizard: `POST /api/setup` creates the admin, the first workspace,
confirms `PERCH_PUBLIC_URL`, records the telemetry choice, and sign-ups stay closed until it has run.
