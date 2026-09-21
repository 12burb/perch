# Perch

**Your code. Your crew. Your bots. Your models. Self-hosted.**

Perch is a self-hosted agentic workspace in one TypeScript monorepo on Bun:

- an **OpenCode-simple IDE**: project → editor → terminal → agent session → diff review;
- a **Slack-shaped team chat** where bots are members, can be `@tagged` by humans and by other bots, and
  work together in threads;
- a **bot forge**: no-code form → YAML spec → TypeScript handler → external Bot API;
- **connections** to GitHub, Vercel, Supabase, Clerk, and any MCP server or OAuth service, with tokens that
  never leave the instance;
- a **preview browser** with a click-to-source inspector for dev servers running in the workspace;
- **Plane-shaped work tracking** (work items, cycles, board, intake) and an approval inbox;
- a **model gateway** that uses any API key, local model (Ollama), or vendor-permitted subscription.

The loop Perch is built around: a task appears in chat → an agent takes it in its own git worktree,
server-side → you watch a preview from your phone → approve the diff → it becomes a PR → the channel sees
the outcome, with cost and trace recorded.

**Open source, your models.** Perch has no paid plans, tiers, or hosted upsell, and nothing is gated behind
one (ADR-0064). Every model runs on credentials you bring: your own API keys or OpenAI-compatible endpoints
(Ollama, LM Studio, vLLM, llama.cpp, OpenRouter…), or your own vendor subscriptions where the vendor
permits it, kept personal and never proxied. The server is AGPL-3.0; the SDKs, UI kit, event catalog,
connector manifests, and templates are MIT (see [License](#license) and [`PLEDGE.md`](PLEDGE.md);
[RFC-0001](docs/rfcs/0001-no-paid-plans.md) adds the no-paid-plans promise to the pledge).

> Status: public beta, v0.3.0. Phases 0–4 of [`TASKS.md`](TASKS.md) have landed — the IDE, chat,
> bots, connections, the model gateway, the Hub, and the install lanes below.

## 60-second install

### Team mode (Docker Compose)

```sh
mkdir perch && cd perch
curl -fsSL https://raw.githubusercontent.com/12burb/perch/main/deploy/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/12burb/perch/main/deploy/Caddyfile -o Caddyfile
curl -fsSL https://raw.githubusercontent.com/12burb/perch/main/.env.example -o .env
# edit .env: set PERCH_PUBLIC_URL and PERCH_MASTER_KEY (openssl rand -base64 32)
docker compose up -d
```

Open `PERCH_PUBLIC_URL`, finish the setup wizard (admin account, first workspace, telemetry checkbox), sign
in. Four containers run by default: `caddy`, `api`, `postgres`, `supervisor`. Add `--profile local` for
Ollama and `--profile tunnel` for a Cloudflare tunnel when you have no public domain.

### Laptop mode (one binary, no Docker)

```sh
curl -fsSL https://raw.githubusercontent.com/12burb/perch/main/install.sh | sh
perch dev
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/12burb/perch/main/install.ps1 | iex
perch dev
```

Or with nix — `nix run github:12burb/perch` — or Homebrew:

```sh
brew tap 12burb/perch https://github.com/12burb/perch && brew install 12burb/perch/perch
```

Every release also builds winget, AUR and npm manifests, but those are not published to their
registries yet; [`docs/install.md`](docs/install.md#package-managers) says which lanes work today.

Nothing is installed that the release did not vouch for: the binary must match the release's
`SHA256SUMS`, and those checksums are signed by the release workflow with cosign (keyless,
Sigstore) — verified too when cosign is on the machine, and required with
`PERCH_REQUIRE_SIGNATURE=1`. `perch upgrade` does the same checks and replaces the running binary in
place. See [`docs/install.md`](docs/install.md).

Laptop mode runs api, web, and an in-process runner on PGlite in `~/.perch`; `perch doctor` checks the
machine, `perch backup` / `perch restore` keep the data safe — and carry a laptop instance into the
compose stack when a team shows up ([`docs/backups.md`](docs/backups.md)).

Binaries ship for Linux (x64, arm64), macOS (Apple silicon, Intel), and Windows (x64); the data lives in
`%USERPROFILE%\.perch` on Windows. CI runs the laptop smoke (`perch dev`, doctor, backup, restore, and
the compiled binary) on Linux, macOS, and Windows on every push.

### Desktop app (laptop mode in a window)

`perch-desktop` runs the same laptop mode in a native window: no browser tab, no terminal. Download
`Perch-macos-arm64.app.zip`, `perch-desktop-windows-x64.exe`, or `perch-desktop-linux-<arch>` from the
release page and open it; data lives in `~/.perch`, shared with `perch dev`. `perch-desktop --url
https://perch.example.com` opens a team instance instead. Details, Linux packages, and the first-launch
notes for unsigned builds are in `docs/desktop.md`.

### From source

```sh
git clone https://github.com/12burb/perch.git && cd perch
bun install --frozen-lockfile
bun run dev
```

Requirements: [Bun](https://bun.sh) 1.3.11 (see `packageManager` in `package.json`).

## What's where

| Path | What |
|---|---|
| `apps/web` | React 19 + Vite PWA — the shell (rail, sidebar, main, panel, drawer) |
| `apps/api` | Hono on Bun — HTTP + WebSocket api, supervisor and worker entrypoints |
| `apps/runner` | Runner agent — PTY, engines, fs, git, ports, preview tunnel |
| `apps/cli` | The `perch` binary — dev, runner connect, doctor, backup, restore, upgrade |
| `packages/*` | db, events, bus, jobs, vault, gateway, engines, connect, bots, policy, preview, inspector, bot-sdk, ui, api-client |
| `connectors/` | `manifest.yaml` per provider + `connectors.json` |
| `templates/` | bot templates, starter stacks, demo workspace seed |
| `deploy/` | `docker-compose.yml`, `Caddyfile`, `Dockerfile.api`, `Dockerfile.runner` |
| `docs/` | the spec, policies, telemetry, RFCs |
| `spikes/` | Phase 0 spikes, kept runnable (outcomes in `DECISIONS.md`) |

## Bring your own brain

API keys and OpenAI-compatible endpoints (OpenAI, Anthropic, xAI, Google, Mistral, Groq, OpenRouter, Ollama,
LM Studio, vLLM, llama.cpp …) go in the encrypted vault and power shared bots, sessions, and the `/v1`
gateway. Subscriptions (ChatGPT Plus/Pro, SuperGrok, GitHub Copilot, Nous Portal, Claude Pro/Max) work only
where the vendor permits, in personal scope, through official or endorsed engines or the hosted terminal.
The rules are in [`docs/policies/providers.md`](docs/policies/providers.md), and the how-to is in
[`docs/brains.md`](docs/brains.md): add a key or an endpoint in workspace settings, name a model as a
**brain**, and pick it when you start a session. A local Ollama is detected and added in one click.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) (DCO sign-off, no CLA), [`GOVERNANCE.md`](GOVERNANCE.md), and the
[`PLEDGE.md`](PLEDGE.md) that keeps the core open. The specification is
[`docs/spec/PERCH-SPEC.md`](docs/spec/PERCH-SPEC.md); the queue is [`TASKS.md`](TASKS.md); decisions live in
[`DECISIONS.md`](DECISIONS.md). Security reports go through
[GitHub Security Advisories](SECURITY.md).

## Development

```sh
bun install --frozen-lockfile
bun run check        # Biome + typecheck + bun test
bun run dev          # api + web + in-process runner against PGlite
bun run e2e          # Playwright against the laptop-mode server
bun run ct           # component tests with axe
bun run perf         # bundle and WS envelope budgets
bun run build        # production builds
```

`bun run e2e` builds `apps/web`, starts the api on port 3999 with PGlite in memory, and runs `e2e/*.e2e.ts`
at 1440 px and 390 px. It needs Playwright's Chromium (`bunx playwright install chromium`); where that
download is unavailable, point `PLAYWRIGHT_CHROMIUM_EXECUTABLE` at a compatible Chromium binary.

## License

AGPL-3.0-only for `apps/*` and every package not listed here; MIT for `packages/bot-sdk`, `packages/ui`,
`packages/events`, `packages/api-client`, `connectors/`, and `templates/`. See [`LICENSE`](LICENSE) and the
`LICENSE` file inside each MIT package. The Perch name and logo are reserved for official builds; forks
rename.
