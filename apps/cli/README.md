# @perch/cli

The `perch` binary (spec §2): `perch init` today; `perch dev` (laptop mode on PGlite), `doctor`,
`backup`, `restore` arrive with task 0.14, `perch runner connect` with task 1.3. Built per platform with
`bun build --compile` by the release workflow (0.15).

```sh
bun apps/cli/src/index.ts init --public-url https://perch.example.com --dir ./perch
# writes ./perch/.env (generated PERCH_MASTER_KEY and POSTGRES_PASSWORD, telemetry off),
#        ./perch/docker-compose.yml (pinned images), ./perch/Caddyfile
cd perch && docker compose up -d   # then open the URL: the setup wizard creates the admin and workspace
```

Add `--preview-domain preview.example.com --dns-provider cloudflare --dns-token …` for wildcard previews
(the Caddyfile gains the `*.{$PERCH_PREVIEW_DOMAIN}` block). In a terminal, missing values are prompted;
`--yes` makes the command non-interactive.
