# Dependencies

Task 0.3. Every package named in spec §2, resolved against the npm registry (the publisher of record for
each project's official docs) on 2026-09-12 and pinned to the exact version below. Renovate moves them weekly
behind CI; a major bump revisits the note in this table and, where one exists, the ADR in `DECISIONS.md`.
Spec §1.3: never guess a package name; nothing in the spec is a version pin.

Toolchain: Bun 1.3.11 (`packageManager`), TypeScript 7.0.2, Biome 2.5.13, Turborepo 2.10.12, Changesets
3.0.2. Bun 1.3 installs workspaces with the isolated linker (`node_modules/.bun`), so every workspace sees
only the packages it declares.

## Where each package lives

| Package | Version | Workspace | Note |
|---|---|---|---|
| `turbo` | 2.10.12 | root (dev) | task graph |
| `@biomejs/biome` | 2.5.13 | root (dev) | lint + format; config migrated with `biome migrate` |
| `typescript` | 7.0.2 | root (dev) | the native compiler; typecheck only (ADR-0019) |
| `@changesets/cli` | 3.0.2 | root (dev) | versioning and changelog |
| `@types/bun` | 1.4.2 | root (dev) | `types: ["bun"]` in server tsconfigs (TS 7 defaults `types` to `[]`) |
| `@playwright/test` | 1.62.1 | root (dev), packages/ui (dev) | pinned to match component testing (ADR-0020) |
| `@playwright/experimental-ct-react` | 1.62.1 | packages/ui (dev) | Playwright component tests |
| `@axe-core/playwright` | 4.13.0 | root (dev), packages/ui (dev) | accessibility assertions |
| `oauth2-mock-server` | 9.2.0 | root (dev) | OIDC provider double for the better-auth generic OIDC test (ADR-0026) |
| `react`, `react-dom` | 19.3.0 | apps/web; packages/ui (peer + dev) | |
| `@types/react`, `@types/react-dom` | 19.3.0 | apps/web (dev), packages/ui (dev) | |
| `vite` | 8.3.0 | apps/web (dev), packages/ui (dev) | Rolldown-based Vite 8 |
| `@vitejs/plugin-react` | 6.1.1 | apps/web (dev), packages/ui (dev) | peer `vite ^8` |
| `@tanstack/react-router` | 1.170.35 | apps/web | file-based routing |
| `@tanstack/router-plugin` | 1.168.37 | apps/web (dev) | generates `routeTree.gen.ts` (committed, Biome-ignored; ADR-0050) |
| `@tanstack/react-query` | 5.102.8 | apps/web | |
| `zustand` | 5.0.15 | apps/web | |
| `tailwindcss`, `@tailwindcss/vite` | 4.3.3 | apps/web (dev), packages/ui (dev) | Tailwind v4 |
| `radix-ui` | 1.6.7 | packages/ui | the unified Radix package shadcn/ui now targets (ADR-0023) |
| `class-variance-authority` | 0.7.1 | packages/ui | shadcn base |
| `clsx` | 2.1.1 | packages/ui | shadcn base |
| `tailwind-merge` | 3.7.0 | packages/ui | shadcn base |
| `lucide-react` | 1.45.0 | apps/web, packages/ui | icons |
| `cmdk` | 1.1.1 | apps/web, packages/ui | command palette |
| `@tanstack/react-virtual` | 3.14.12 | apps/web, packages/ui | every long list is virtualized |
| `@dnd-kit/core` | 6.3.1 | apps/web | board drag and drop |
| `@dnd-kit/sortable` | 10.0.0 | apps/web | |
| `@tiptap/react`, `@tiptap/starter-kit` | 3.31.3 | apps/web | work item descriptions |
| `codemirror` | 6.0.2 | apps/web | editor bundle |
| `@codemirror/state` | 6.7.4 | apps/web | |
| `@codemirror/view` | 6.43.11 | apps/web | |
| `@codemirror/language` | 6.12.4 | apps/web | |
| `@codemirror/commands` | 6.11.0 | apps/web | |
| `@codemirror/search` | 6.7.2 | apps/web | |
| `@codemirror/merge` | 6.12.2 | apps/web | diff review |
| `@codemirror/language-data` | 6.5.2 | apps/web | ~40 languages, lazily loaded |
| `@codemirror/lang-markdown` | 6.5.2 | apps/web | markdown editing (task 1.6) |
| `@lezer/markdown` | 1.7.2 | apps/web | the markdown parser behind the preview renderer (task 1.6; no HTML pass-through) |
| `@lezer/common` | 1.5.2 | apps/web | syntax-tree types for the markdown renderer |
| `@tiptap/react` | 3.31.3 | apps/web | the work item description (task 3.26); loaded with the panel, never with the first paint |
| `@tiptap/starter-kit` | 3.31.3 | apps/web | the marks and nodes that description uses |
| `@tiptap/pm` | 3.31.3 | apps/web | ProseMirror, as Tiptap packages it |
| `@xterm/xterm` | 6.0.0 | apps/web | terminal |
| `@xterm/addon-fit` | 0.11.0 | apps/web | |
| `@xterm/addon-web-links` | 0.12.0 | apps/web | |
| `vite-plugin-pwa` | 1.3.0 | apps/web (dev) | PWA manifest and service worker |
| `hono` | 4.13.7 | apps/api | `Bun.serve` with native WebSockets |
| `@hono/zod-openapi` | 1.6.3 | apps/api | OpenAPI document (peer `zod ^4`) |
| `zod` | 4.6.3 | every package with a boundary | Zod 4 everywhere (Hono, AI SDK, better-auth all accept ^4) |
| `better-auth` | 1.7.4 | apps/api, apps/web (client) | email + password, generic OIDC, Drizzle adapter; `better-auth/react` client |
| `@better-auth/passkey` | 1.7.4 | apps/api, apps/web (client) | passkeys moved out of core in better-auth 1.7 |
| `drizzle-orm` | 0.45.2 | apps/api, packages/db, packages/jobs | one `Db` type over both drivers |
| `drizzle-kit` | 0.31.10 | packages/db (dev) | the stable line; 1.0 is still an RC (ADR-0024) |
| `postgres` | 3.4.9 | apps/api, packages/db | postgres.js, team mode |
| `@electric-sql/pglite` | 0.5.8 | apps/api, packages/db | laptop mode and tests; `vector`, `citext` from `contrib` |
| `croner` | 10.0.1 | packages/jobs | cron parsing and scheduling |
| `pino` | 10.3.1 | apps/api | logs; `pino-pretty` 13.1.3 dev only |
| `@opentelemetry/api` | 1.9.1 | apps/api | |
| `@opentelemetry/sdk-node` | 0.222.0 | apps/api | OTLP export off by default |
| `@opentelemetry/exporter-trace-otlp-http` | 0.222.0 | apps/api | |
| `@opentelemetry/sdk-trace-base` | 2.11.0 | apps/api (dev) | The in-memory exporter task 3.22's trace test asserts against; already the resolved version under `sdk-node` |
| `dockerode` | 5.0.1 | apps/api | supervisor entrypoint only (spike 0.4.7); `@types/dockerode` 4.0.1 dev |
| `yaml` | 2.9.1 | apps/api, packages/connect, packages/policy | manifests, bot.yaml, policy.yaml |
| `ai` | 7.0.99 | packages/gateway | Vercel AI SDK 7 |
| `@ai-sdk/openai` | 4.0.66 | packages/gateway | |
| `@ai-sdk/anthropic` | 4.0.53 | packages/gateway | |
| `@ai-sdk/xai` | 4.0.58 | packages/gateway | |
| `@ai-sdk/google` | 4.0.69 | packages/gateway | |
| `@ai-sdk/mistral` | 4.0.43 | packages/gateway | |
| `@ai-sdk/groq` | 4.0.41 | packages/gateway | |
| `@ai-sdk/openai-compatible` | 3.0.48 | packages/gateway | Ollama, LM Studio, vLLM, llama.cpp, aggregators |
| `@modelcontextprotocol/sdk` | 1.30.0 | packages/connect, apps/api, apps/runner | MCP client and server, client auth (CIMD, DCR, PKCE) |
| `@agentclientprotocol/sdk` | 1.4.0 | packages/engines, apps/runner | the official ACP TypeScript SDK (ADR-0021) |
| `@opencode-ai/sdk` | 1.18.30 | packages/engines, apps/runner | OpenCode server client; the binary is pinned in the runner image |
| `opencode-ai` | 1.18.30 | spikes only | the npm-distributed OpenCode binary, used by spike 0.4.3 |
| `@playwright/mcp` | 0.0.80 | apps/runner | agent eyes inside the runner |
| `bun-pty` | 0.4.10 | apps/runner, spikes/pty | the PTY on Bun: spike 0.4.1 showed node-pty failing on Bun (ADR-0029) |
| `node-pty` | 1.1.0 | spikes/pty only | opt-in probe for the CI platform matrix; trusted install script (compiles from source on Linux) |
| `@webviewjs/webview` | 0.4.5 | apps/desktop | the desktop window: N-API binding to tao/wry (WebView2, WebKit, WebKitGTK 4.1), prebuilt per platform, Rust stays upstream (ADR-0063) |
| `@electric-sql/pglite-pgvector` | 0.0.9 | packages/db (from task 0.5), spikes/pglite | pgvector for the PGlite 0.5 line ships as its own package (ADR-0032) |
| `simple-git` | 3.36.0 | apps/runner | git |
| `chokidar` | 5.0.0 | apps/runner | file watching |
| `quickjs-emscripten` | 0.32.0 | packages/bots | WASM sandbox for code bots |
| `arctic` | 3.7.0 | packages/connect | plain OAuth2 providers from manifests |
| `openapi-fetch` | 0.17.0 | packages/api-client | the generated TypeScript SDK's runtime (ADR-0022) |
| `openapi-typescript` | 7.13.0 | packages/api-client (dev) | generates the SDK types from `/api/openapi.json` |
| `typescript` (5.x line) | 5.9.3 | packages/api-client (dev) | the compiler API `openapi-typescript` needs; scoped to this workspace by the isolated linker (ADR-0042) |

## Deliberately not added

- `uuid` / `uuidv7`: `Bun.randomUUIDv7()` generates every id (ADR-0025).
- `i18next` and friends: `t("key")` is an in-house typed lookup over JSON catalogs (ADR-0027).
- `isolated-vm`: V8-only, does not run on Bun (spec §2).
- Redis clients, queues, object-store SDKs: spec §3.1; an S3 client arrives only with `PERCH_S3_*` support.

## Version policy

Exact pins everywhere (`scripts/repo-invariants.test.ts` fails on a range). Workspace links use
`workspace:*`. Renovate groups minor and patch updates weekly and opens majors one at a time behind the
dependency dashboard.

## Container images (task 0.13, ADR-0058)

Resolved from Docker Hub and PyPI on 2026-09-13 (Hermes Agent on 2026-09-16); Renovate keeps them
current. Hermes Agent is installed from its own repository at a tag rather than from PyPI, because
upstream deprecated the `hermes-agent` PyPI package at v0.19.0 and the install path since is the
repository checkout (task 3.8, ADR-0123).

The four official agent CLIs are pinned in one place — `deploy/agents.json` — which the runner
image installs from and then ships at `/opt/perch/agents.json`, so what a runner reports is what
was installed (task 4.6, ADR-0152).

The docs site is a project of its own (`docs/site`) with its own lockfile: it is built in CI and at
release time, never installed by the monorepo, so Astro's dependency tree stays out of every other
install and out of both images (task 4.7, ADR-0153).

| Docs site | Pin | Where |
|---|---|---|
| `astro` | `7.3.3` | `docs/site/package.json` |
| `@astrojs/starlight` | `0.42.1` | `docs/site/package.json` (search is its own Pagefind index, built at build time) |
| `sharp` | `0.34.5` | `docs/site/package.json` (Astro's image pipeline) |

| Image / tool | Pin | Where |
|---|---|---|
| `oven/bun` | `1.3.11`, `1.3.11-slim` | `deploy/Dockerfile.api` |
| `node` | `24.21.0-bookworm-slim` (LTS; the `node` binary for Vite in the api build stage) | `deploy/Dockerfile.api` |
| `ubuntu` | `24.04` | `deploy/Dockerfile.runner` |
| Node tarball | `24.21.0` (SHASUMS256-verified) | `deploy/Dockerfile.runner` |
| uv | `0.12.13` | `deploy/Dockerfile.runner` |
| Playwright Chromium | `1.62.1` | `deploy/Dockerfile.runner` |
| `@openai/codex` (Codex CLI) | `0.154.0` | `deploy/agents.json` → the runner image's `agents` stage |
| `@anthropic-ai/claude-code` (Claude Code) | `2.1.273` | `deploy/agents.json` |
| `@google/gemini-cli` (Gemini CLI) | `0.60.0` | `deploy/agents.json`, and the ACP table's npx pin |
| `opencode-ai` (binary) | `1.18.30` (held at `@opencode-ai/sdk`'s version: the client and the server it drives move together) | `deploy/agents.json` |
| `@agentclientprotocol/codex-acp` | `1.12.0` | `deploy/agents.json`, and the ACP table's npx pin |
| `@agentclientprotocol/claude-agent-acp` | `0.78.0` | `deploy/agents.json`, and the ACP table's npx pin |
| Hermes Agent | `v2026.9.14` (git tag; package version `0.21.3`, extra `[acp]`, Python 3.12) | `deploy/Dockerfile.runner`, `HERMES_VERSION` in `apps/runner/src/hermes.ts` |
| `caddy` | `2.11.4`, `2.11.4-builder` | `deploy/Dockerfile.caddy` |
| `pgvector/pgvector` | `0.8.6-pg16` | `deploy/docker-compose.yml` |
| `ollama/ollama` | `0.34.0` (profile `local`) | `deploy/docker-compose.yml` |
| `cloudflare/cloudflared` | `2026.9.1` (profile `tunnel`) | `deploy/docker-compose.yml` |
