# PERCH — Build Plan

### Self-hosted agentic workspace: IDE + team chat + bots + any model

**Working title:** Perch (alternates: Aviary, Hatch). Fits the 12birb / Nest / Roost lineage: the place where you and your birds land.

> **Cover line:** *Your code. Your crew. Your bots. Your models. One `docker compose up`.*
> A self-hosted room where the editor, the team chat, and the bots share the same walls — and every seat runs on whatever brain you already pay for: OpenAI, xAI, Anthropic API, Nous Portal, Ollama on the laptop, or the CLI you're already logged into.

**Status:** Plan v2.0 (build-ready) — September 12, 2026. History: v1.1 Connections (§4.6, §5.5) and open source (§12); v1.2 preview browser and inspector (§5.6); v1.3 gap analysis applied (laptop mode, ACP, standards pack, interactive blocks, the agent loop §5.7, decisions 12–15); v1.4 T3 Code review (runners and local runner, `cli-harness`, per-turn diffs, decision 16); v1.5 credential matrix (§4.7); v1.6 bot-to-bot mentions (§5.8); v1.7 UI/UX system (§5.0). v2.0 makes the document buildable: every remaining "or" is decided (TypeScript end to end on Bun; four containers; Postgres for everything; no Redis and no object store by default), §6 is a normative schema, and §15–17 add the build sheet (repo layout, env, compose, CI, conventions, Phase 0 spikes), the API and protocol contracts, and the dependency-ordered task list for Phases 0–2. Hand this file to Claude Code and start at §17. Provider, ToS, and MCP-auth facts were verified against current sources on these dates; re-verify at the start of every phase.

---

## 1. What we're building

Six pillars, mapped 1:1 to the ask.

| # | Ask | Pillar | One-liner |
|---|-----|--------|-----------|
| 1 | Simple IDE like OpenCode | **Perch IDE** | Project → editor → terminal → agent session → diff review. Three panes, one config file, ⌘K. |
| 2 | Chat with bots (Grok etc.) | **Bot chat** | DM any bot; `@grok` in any thread, X-style. Model picker per bot. |
| 3 | Slack-like messaging | **Perch Chat** | Workspaces, channels, DMs, threads, mentions, reactions, files, search, presence. Bots are members. |
| 4 | Make bots | **Bot Forge** | No-code form → YAML spec → TypeScript handler → external Bot API. Triggers, tools, budgets. |
| 5 | Any API / subscription | **Brains** | Model registry + OpenAI-compatible gateway + engine adapters. API keys, local models, subscription lanes through official or endorsed engines. |
| 6 | Connect to auth-required programs | **Connections** | OAuth, MCP, and token connections to GitHub, Vercel, Supabase, Clerk, and anything else. Per user, encrypted, never exposed to models. Self-hosters connect without registering apps wherever the vendor supports it. |

The glue is the product. OpenCode already solved agentic coding, Hermes already solved agent runtime, the AI SDK already solved provider adapters, and MCP already solved service connections. Perch builds the room: chat, bot platform, gateway, connections, UI, and a deploy story that fits on one line — and ships it open source.

## 2. Design principles ("simple like OpenCode")

1. **One command install.** `docker compose up` → setup wizard → first workspace in under five minutes.
2. **One shell.** Rail, sidebar, main, panel, drawer — the same five regions in every mode, with content that swaps. Rail + sidebar + main by default; panel and drawer on demand. Command palette for everything else. (§5.0)
3. **Agent-first coding.** Chat → plan → build → diff → accept. The session is primary; the file tree is secondary.
4. **A message is a message.** One primitive in a channel, a DM, and a coding session, so humans, bots, and agents share one event model.
5. **Bring your own brain, keep your own keys.** Per-user and per-workspace credentials, encrypted at rest, never sent to a model, never proxied where a vendor forbids it.
6. **Don't rebuild the engine.** Adapters over rewrites. Swap engines later without touching chat or bots.
7. **Phone-usable.** PWA. Chat and the session pane are first-class on a 6-inch screen.

## 3. Provider reality check (verified September 2026)

This shapes the architecture, so it comes first.

| Brain | API key | Subscription | Notes |
|---|---|---|---|
| **OpenAI** | ✅ | ✅ ChatGPT Plus/Pro (personal) | Codex OAuth is publicly endorsed by OpenAI's Codex lead for third-party harnesses. OpenCode supports it natively via `/connect` (added v1.1.11, Jan 2026; restored v1.15.7). The subscription only applies when the engine hits OpenAI's own Codex endpoint; it cannot be routed through a proxy. Personal use, not shared bots. |
| **xAI (Grok)** | ✅ | ✅ SuperGrok (personal) | Native xAI OAuth landed in OpenCode v1.15.7 (May 2026). Workspace-wide Grok bots run on the API key (grok-4.x). |
| **Anthropic (Claude)** | ✅ Console key | ❌ in any third-party harness | ToS clarified Feb 2026, enforced Apr 4, 2026: Pro/Max/Team cover Claude Code and Cowork only; the Agent SDK also requires an API key. OpenCode removed Claude subscription auth in v1.3.0. Anthropic announced an "extra usage" pay-as-you-go option on Claude accounts for third-party harnesses; verify current terms at docs.claude.com before building on it. The compliant way to use a Max plan inside Perch is Lane C: Claude Code itself in the hosted terminal. |
| **Nous (Hermes)** | via OpenRouter or any key | ✅ Nous Portal (OAuth) | One login → 300+ models plus the Tool Gateway (search, image, TTS, cloud browser). The Portal exposes a subscription proxy for non-Hermes tools. Hermes Agent also supports the Codex subscription (`hermes auth add openai-codex`), Ollama, and custom endpoints. |
| **GitHub Copilot** | — | ✅ (personal) | Via OpenCode `/connect`. |
| **Google (Gemini)** | ✅ | terminal lane only | Gemini CLI in Lane C if you hold a Google AI plan; API key for bots. |
| **Local** | n/a | free | Ollama, LM Studio, vLLM, llama.cpp — all OpenAI-compatible. The Zephyrus G16 (32 GB) comfortably hosts 7–14B chat bots as the free tier. |
| **Aggregators** | ✅ | — | OpenRouter, Cloudflare AI Gateway, OpenCode Zen/Go, LiteLLM. One key, many models, OpenAI-compatible. |

### The three lanes

- **Lane A — API keys → Perch gateway.** Workspace-shared or personal keys. Powers shared bots, automations, cron, anything multi-user. Always works; never depends on vendor goodwill.
- **Lane B — Subscription OAuth inside an official or endorsed engine.** OpenCode `/connect` (ChatGPT, SuperGrok, Copilot); Hermes (`hermes portal`, Codex). The credential lives in the *user's* home volume and serves only that user's interactive sessions and private bots. Perch never implements vendor OAuth itself and never spoofs a client ID.
- **Lane C — Hosted terminal, official CLIs.** Claude Code, Codex CLI, Gemini CLI, Hermes, and the OpenCode TUI are preinstalled in the runner; each user logs in under their own account in their own home volume. Perch is a terminal here, not a harness.

**Hard rule:** a bot visible to more than one person runs on Lane A or a local model. Lane B/C credentials are user-scoped and non-transferable.

Sources checked: The Register (Feb 20, 2026) on Anthropic's ToS clarification; OpenCode changelog (Aug–Sept 2026); Hermes Agent docs on Nous Portal and providers; Claude Code docs — https://docs.claude.com/en/docs/claude-code/overview

## 4. Architecture

### 4.1 System

```
┌──────────────────────── Browser / PWA (React) ─────────────────────────┐
│  Chat (channels, DMs, threads) │ IDE (tree, editor, terminal, session) │ Bots │
└───────────────┬──────────────────────────────┬─────────────────────────┘
                │ HTTPS + WebSocket            │
┌───────────────▼──────────────────────────────▼─────────────────────────┐
│ api (Node/Hono): auth · workspaces · chat · bots · registry · gateway  │
│ connections (OAuth/CIMD/tokens) · MCP gateway · Bot API · /v1 · events │
└──────┬──────────────────┬───────────────────────────┬──────────────────┘
       │                  │                           │ WS (brokered, short-lived tokens)
┌──────▼──────┐   ┌───────▼───────┐   ┌───────────────▼──────────────────┐
│  postgres   │   │  files        │   │ supervisor → runner per workspace │
│  +pgvector  │   │  local or S3  │   │  project volumes · user homes     │
└─────────────┘   └───────────────┘   │  node-pty terminals               │
                                      │  OpenCode server · Hermes Agent   │
                                      │  bot sandboxes · official CLIs    │
                                      └───────────────┬──────────────────┘
                                                      │
                     ┌────────────────────────────────▼───────────────────┐
                     │ Brains: OpenAI · xAI · Anthropic API · Nous Portal │
                     │ OpenRouter · Ollama/vLLM · any OpenAI-compatible   │
                     ├────────────────────────────────────────────────────┤
                     │ Connected services (per user, via MCP gateway):    │
                     │ GitHub · Vercel · Supabase · Clerk · any MCP/OAuth │
                     └────────────────────────────────────────────────────┘
```

### 4.2 Services (`docker-compose.yml`)

Four containers by default. Everything else is a profile or an environment variable.

| Service | Image | Role |
|---|---|---|
| `caddy` | caddy:2 (with the DNS plugin build) | TLS (Let's Encrypt or local CA), reverse proxy, WebSocket passthrough, wildcard cert for previews via DNS challenge |
| `api` | perch/api | One Bun process: Hono HTTP + WebSocket, auth, workspaces, chat, bots, registry, gateway, connections, MCP gateway, preview proxy, Bot API, jobs worker, event bus. Serves the built web app. |
| `postgres` | pgvector/pgvector:pg16 | System of record, full-text search, vectors, the job queue (SKIP LOCKED), session events |
| `supervisor` | perch/api (entrypoint `supervisor`) | Owns the Docker socket (api does not). Creates one `runner` container per workspace on demand, enforces CPU, memory, and pid limits, idles them out |
| `runner` (dynamic) | perch/runner | Per-workspace sandbox: project volumes, per-user home volumes, PTY terminals, OpenCode server, ACP agents, Hermes Agent, bot sandboxes, official CLIs (claude, codex, gemini, hermes, opencode), git, Bun, Node, Python + uv |
| `ollama` | ollama/ollama | Profile `local`; GPU passthrough when present |
| `cloudflared` | cloudflare/cloudflared | Profile `tunnel`; public HTTPS for OAuth callbacks, webhooks, and previews behind NAT |

No Redis and no object store in the default deployment. The api is a single process, so the event bus is in-process, jobs live in Postgres, and presence and rate limits are in memory. Files go to a local volume by default and to any S3-compatible bucket when `PERCH_S3_*` is set. A Redis-backed bus and queue are Phase 5 adapters for multi-node; the `Bus` and `Queue` interfaces exist from Phase 0 so nothing above them changes.

`PERCH_RUNNER_MODE=shared` runs one runner for all workspaces (single-box installs). `PERCH_PUBLIC_URL` is the one setting every OAuth callback, webhook, and the CIMD document derive from; the setup wizard prints the exact URLs to paste into vendor dashboards.

**Runners are a first-class concept.** A runner is wherever sessions, terminals, previews, and CLIs execute. Three kinds, chosen per project or per session:

| Runner | Where it runs | Why |
|---|---|---|
| **Hosted** (default) | A container the supervisor creates per workspace on the Perch host | Shared projects, background work, cron, webhooks, anything multi-user |
| **Local** | Your laptop, homelab, or GPU box: `perch runner connect <workspace>` opens an outbound WebSocket to the api, registers as one of your environments, and hosts your sessions there. No inbound ports, no tunnel. | Your subscriptions and CLI logins stay on your machine (Lanes B and C), your GPU serves Ollama, your code never leaves the box, and the room stays shared. Also the migration path for T3 Code users. |
| **Remote** | Any VM or box you own, same `perch runner connect`, kept on | A team GPU server or a beefy build machine shared through grants |

The api brokers all traffic to runners with short-lived tokens; a local runner is reachable only by its owner and by workspace bots the owner grants. Runner status, load, and cost show in the workspace's Environments page.

### 4.3 Stack (final; the build sheet in §15 has the details)

**Language: TypeScript, end to end. Runtime: Bun.** One language for web, api, supervisor, runner, CLI, and the single binary; one type system across every boundary; the ecosystem Perch stands on (AI SDK, MCP SDK, ACP SDK, OpenCode SDK, Drizzle, PGlite, better-auth, CodeMirror, xterm) is TypeScript-first; Bun gives a solo builder the fastest install, test, and bundle loop, `bun build --compile` for the laptop binary, and it is proven in this exact category (OpenCode ships on it). Python appears only as third-party agent runtimes inside the runner image (Hermes Agent, via uv). No Go, no Rust.

- **Monorepo:** Bun workspaces + Turborepo (task graph, remote cache). Biome for lint and format. TypeScript strict with `noUncheckedIndexedAccess`. Zod at every boundary. Changesets for versioning. Renovate for dependencies.
- **Web (`apps/web`):** React 19 + Vite, TanStack Router (file-based) + TanStack Query, Zustand, Tailwind v4 + shadcn/ui (Radix), CodeMirror 6 with `@codemirror/merge` and `@codemirror/language-data`, `@xterm/xterm` + fit and web-links addons, cmdk, dnd-kit, TanStack Virtual, Tiptap, lucide-react, `vite-plugin-pwa`. Tokens as CSS variables in `packages/ui/tokens`; a theme is a token set.
- **API (`apps/api`):** Hono on `Bun.serve` with native WebSockets; `@hono/zod-openapi` generates the OpenAPI document that produces the TypeScript and Python SDKs; better-auth with the Drizzle adapter (email + password, passkeys, generic OIDC); Drizzle ORM over `postgres` (team) or `@electric-sql/pglite` (laptop) behind one `Db` type; `packages/jobs` — a Postgres queue (SKIP LOCKED, retries with backoff, cron via `croner`); `packages/bus` — typed in-process pub/sub with the Redis adapter reserved for Phase 5; pino logs; OpenTelemetry SDK with OTLP export off by default.
- **AI (`packages/gateway`, `packages/engines`):** Vercel AI SDK providers `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/xai`, `@ai-sdk/google`, `@ai-sdk/mistral`, `@ai-sdk/groq`, `@ai-sdk/openai-compatible`; `@modelcontextprotocol/sdk` (client and server); the official ACP TypeScript SDK; `@opencode-ai/sdk`; `@playwright/mcp` inside the runner.
- **Runner (`apps/runner`):** Bun process, outbound WebSocket to the api (§16.6), `node-pty` for terminals (the Phase 0 spike in §15.6 decides `bun-pty` per platform), the `git` binary driven through `simple-git`, chokidar for file watching, listening-port discovery from `/proc/net/tcp` on Linux and `lsof` elsewhere.
- **Sandboxing:** QuickJS (WASM, `quickjs-emscripten`) for code bots — a real isolation boundary that runs on Bun, with no host access unless a tool is granted; runner containers for anything heavier. `isolated-vm` is V8-only and does not run on Bun, so it is out.
- **Secrets:** envelope encryption, AES-256-GCM through WebCrypto, root key from `PERCH_MASTER_KEY`; KMS and age providers land behind the same `Vault` interface later.
- **Testing:** `bun test` for unit and integration (PGlite in memory for database tests), Playwright for e2e, a compose smoke test and a laptop-mode smoke test in CI, `@axe-core/playwright` for accessibility.
- **Laptop mode (`apps/cli`):** `perch` is one Bun-compiled binary per platform (linux x64 and arm64, macOS arm64 and x64, Windows x64) that runs api, web, and an in-process runner on PGlite with the vector extension, on the same Drizzle schema. `curl -fsSL get.perch.dev | sh` → IDE + chat + bots in 60 seconds, no Docker, Ollama auto-detected. `perch migrate --to-compose` dumps and restores into Postgres when a team shows up.
- **Package names and versions:** resolve exact package names and pin exact versions at Phase 0 from each project's official docs, record them in `DECISIONS.md`, and let Renovate move them weekly behind CI. Nothing in this document is a version pin.

### 4.4 Engine adapters

The IDE and the bot runtime never call a model directly for agentic work. They call an `Engine`.

```ts
interface Engine {
  id: "acp" | "opencode" | "cli-harness" | "native" | "hermes" | "cli" | "openclaw" | "native-code";
  capabilities: { code: boolean; tools: boolean; subagents: boolean; streaming: boolean };
  createSession(p: {
    workspaceId: string; projectId?: string; userId: string;
    model: ModelRef; systemPrompt?: string;
  }): Promise<Session>;
  send(sessionId: string, input: UserTurn, opts?: { mode: "plan" | "build" }): AsyncIterable<EngineEvent>;
  respondPermission(sessionId: string, permissionId: string, answer: "allow" | "always" | "deny"): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}

type EngineEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; output: string; diff?: FileDiff[] }
  | { type: "permission"; id: string; tool: string; args: unknown }
  | { type: "usage"; input: number; output: number; costUsd: number }
  | { type: "done" }
  | { type: "error"; message: string };
```

| Adapter | Use | When |
|---|---|---|
| `acp` | **The engine contract.** A generic Agent Client Protocol client in the runner: any agent in the ACP Registry becomes an engine — Claude Code (via Zed's adapter), Codex, Gemini CLI, GitHub Copilot CLI, Goose, OpenCode. Sessions, permissions, tool calls, diffs, terminals, modes, and forking map straight onto `EngineEvent`. Perch's own tools (chat, preview, connections) reach agents through ACP's MCP passthrough. Remote ACP over HTTP/WS as the spec lands. Lane rules apply per agent: subscription-authed agents run under the invoking user's home volume; shared bots use Lane A. | v1 |
| `opencode` | Coding sessions with OpenCode's extras beyond ACP. Spawns `opencode serve` per project in the runner and drives it through the OpenCode SDK; surfaces plan/build agents, subagents, MCP config. Provider config injected from the registry (API keys) or read from the user's own `/connect` state (Lane B). | v1 default coding engine |
| `cli-harness` | Drives official CLIs in their documented headless modes under the user's own login: Codex `exec --json`, Claude Code `-p --output-format stream-json`, Gemini CLI, Grok Build, Antigravity, Cursor CLI. Output mapped onto `EngineEvent`; permissions via each CLI's own approval hooks. Personal scope only, runs in the user's home (usually on a local runner). This is how T3 Code delivers bring-your-own-subscription; verify each vendor's current terms for GUI wrappers before enabling it by default. Shared bots keep using Lane A. | Phase 1–2 |
| `native` | Conversational bots and lightweight tools. AI SDK `streamText` + Perch tool registry. About a day to build; no external process. | v1 default bot engine |
| `cli` | Lane C. No adapter, just the PTY. | v1 |
| `hermes` | Hermes Agent as a runtime, per bot or per user in the runner. Nest agents (Birbus, Dawn, Julius, Paige, Kimi and the rest) join channels as members with their existing skills. | Phase 3 |
| `openclaw` | Optional: your personal assistant in the room. | Later |
| `native-code` | Own agentic coding loop (read, edit, bash, grep tools) as an escape hatch if OpenCode's API churn ever bites. | Phase 5 |

Pin the OpenCode version in the runner image. The adapter is the only file that touches its API. Confirm the current server and SDK surface at opencode.ai/docs before Phase 1.

### 4.5 Model registry and gateway ("Brains")

- **Registry:** `provider_credential` (scope: user or workspace; kind: api_key, oauth_ref, endpoint; encrypted), `model_profile` (display name, provider, model id, params, tool policy, cost cap, default-for chat or code), catalog seeded from models.dev plus manual entries, per-workspace allow-list.
- **Gateway:** OpenAI-compatible `POST /v1/chat/completions`, `GET /v1/models`, `POST /v1/embeddings`, backed by AI SDK providers. Virtual keys (`pk_...`) scoped to workspace, user, or bot with daily and monthly budgets. Streaming. Every call logs tokens and cost to `usage_event`. Fallback chains per profile. Anything that speaks OpenAI (Hermes, scripts, OpenCode as a custom provider, Nest cron jobs) can point at Perch and share audited workspace keys.
- **Fidelity rule:** the OpenCode engine gets native provider credentials (keeps prompt caching, extended thinking, provider-specific params). The gateway serves chat bots and external consumers.
- **LiteLLM, OpenRouter, and every other aggregator** are supported only as OpenAI-compatible endpoints you point Perch at. None of them is part of the deployment.

### 4.6 Connections layer (OAuth, MCP, tokens)

Goal: any self-hosted instance connects to Vercel, Supabase, GitHub, Clerk, and anything else that speaks OAuth or MCP, without the Perch project holding anyone's secrets and without the self-hoster registering an OAuth app for every service.

**Registration lanes, tried in this order (mirrors the MCP authorization spec's priority):**

1. **Pre-registered client.** The admin pasted a client ID and secret (BYO OAuth app). Used whenever present.
2. **CIMD — Client ID Metadata Document.** The instance publishes `https://<PERCH_PUBLIC_URL>/.well-known/oauth-client-metadata.json` (name, redirect URIs, logo, optional JWKS for `private_key_jwt`) and uses that URL as its `client_id`. No registration endpoint, no per-instance client records on the vendor side. MCP spec 2025-11-25 introduced it; the 2026-07-28 revision made it the primary path and deprecated DCR (kept for at least 12 months). Clerk supports it today (beta); expect the rest to follow.
3. **DCR (RFC 7591).** Fallback for servers that still only offer dynamic registration (Supabase MCP today).
4. **Token paste.** PAT or API key with scope guidance. Always available; best for headless bots and CI.

**Build:**

- `packages/connect`: provider manifests (YAML) plus flows. MCP OAuth (RFC 9728 protected-resource discovery → RFC 8414 or OIDC authorization-server metadata → CIMD, DCR, or pre-registered → PKCE) comes from the official `@modelcontextprotocol/sdk` client auth. Plain OAuth2 providers use Arctic (MIT, 50+ providers) driven by the manifest.
- **Vault:** same envelope encryption as model keys; access and refresh tokens; refresh jobs on the Postgres queue; revoke on disconnect (calls the vendor's revocation endpoint when one exists).
- **MCP gateway** (`/mcp/:connectionId`): Perch exposes every connection as an MCP server endpoint of its own, authenticated by the Perch session or a virtual key. Upstream calls carry the connection's delegated token; downstream consumers (OpenCode sessions, native bots, Hermes and Nest via the Bot API, the IDE UI) never see raw tokens. Tool allow-lists, permission prompts, rate limits, and audit live here. Local stdio MCP servers in the runner are exposed through the same endpoint shape.
- **Consumers:** OpenCode gets the user's connected MCP servers injected into its config as HTTP MCP servers pointing at the gateway; native bots get them as tools; external agents call `POST /api/v1/tools.call` with a grant; IDE features (Deploy, DB panel, Open PR) call connector operations directly.

**Scope and on-behalf-of policy:**

- Connections are **personal** by default (owner = user). They power that user's IDE sessions, DMs with bots, and shared bots only when the bot is marked `obo: true` and *that user* invokes it (the bot acts as the invoker).
- **Workspace connections** are created by admins for automations (cron, webhooks, shared bots) and require an explicit grant: which bots, which channels, which tools. Prefer service identities: GitHub App installation tokens, Vercel team tokens, Supabase PATs scoped to one project in read-only mode.
- Every use writes `audit_log` (who, which connection, which tool, args hash, result status).

**Self-host callbacks:** OAuth needs a stable HTTPS URL. `PERCH_PUBLIC_URL` drives every callback and the CIMD document. The wizard documents four options: public domain (Caddy auto-TLS), `--profile tunnel` (cloudflared), Tailscale Serve or Funnel, or `http://localhost:PORT` for single-user dev (GitHub and most vendors accept loopback redirects).

**Inbound webhooks:** GitHub (PRs, issues, Actions), Vercel (deployments, runtime errors), Supabase (database webhooks) post to `/hooks/:provider/:id` with signature verification and land in channels as cards.

### 4.7 Bring anything: the credential matrix

One screen for the question "will it work with what I already have?" Every row is already specified elsewhere; this is the index.

| You bring | Perch uses it through | Who can use it | Where it lives |
|---|---|---|---|
| **API key** — OpenAI, Anthropic, xAI, Google, Mistral, Groq, DeepSeek, OpenRouter, any provider the AI SDK knows | Registry → gateway for chat bots and `/v1`; injected natively into engines (OpenCode, ACP agents) for full fidelity | You, or the whole workspace if an admin shares it | Encrypted vault on the Perch host |
| **OpenAI-compatible endpoint** — Ollama, LM Studio, vLLM, llama.cpp, LiteLLM, Nous Portal proxy, Cloudflare AI Gateway, OpenCode Zen/Go | Same path as an API key: endpoint + optional key | You or workspace | Vault; local models run on whichever runner has the GPU |
| **ChatGPT Plus/Pro, SuperGrok, GitHub Copilot subscription** | Lane B: OAuth inside OpenCode (`/connect`); or the `cli-harness` engine driving Codex CLI | You only, in your own sessions and private bots | Your home volume on a hosted or local runner; never the vault |
| **Claude Pro/Max** | Lane C: Claude Code itself in the hosted terminal or on your local runner. `cli-harness` for Claude Code stays off until Anthropic's terms for GUI wrappers are confirmed. Anything in an engine or a bot uses an Anthropic API key | You only | Your home volume |
| **Nous Portal subscription** | Hermes engine (`hermes portal`), plus the Portal's subscription proxy as an OpenAI-compatible endpoint | You | Home volume; proxy token in the vault |
| **Google AI plan** | Gemini CLI in the terminal lane or through `cli-harness` | You | Home volume |
| **An account on a service** — GitHub, Vercel, Supabase, Clerk, Google, Slack, Notion, Linear, anything with OAuth | Connections: pre-registered app → CIMD → DCR → BYO app → token paste, whichever the vendor supports. Tokens only ever leave through the MCP gateway | You by default; workspace bots and automations only through an admin grant that names bots, channels, and tools | Vault; engines, bots, models, and external agents never see the token |
| **A remote MCP server** — any URL | Add server → OAuth via Connections → served at `/mcp/:connectionId` to OpenCode and ACP agents, native bots, and the Bot API's `tools.call` | You or workspace, per grant | Vault |
| **A local or stdio MCP server** | Runs inside the runner (hosted or local); exposed through the same `/mcp/...` shape with the same allow-lists and audit | Per runner | Runner |
| **A GitHub App installation** | GitHub App connector: short-lived installation tokens, webhooks, check runs; PAT as fallback | Workspace, per repo | Vault |
| **Perch itself, as an MCP server** | Claude Desktop, Cursor, T3 Code's agents, or a Nest cron job read channels, post, open tasks, and call granted connections | Per user token or virtual key | — |

Two rules make the table safe:

1. **Shared means keys or local.** Anything visible to more than one person runs on Lane A (API keys) or a local model. Subscription credentials are user-scoped and non-transferable; Perch never proxies them and never implements a vendor's OAuth itself.
2. **Tokens never leave Perch.** Engines, bots, and external agents reach connected services only through the MCP gateway or `tools.call`, under a grant, with audit. Perch never forwards a caller's bearer token upstream.

The honest caveat: "any subscription" means any subscription the vendor allows outside its own client. As of September 2026 that is OpenAI, xAI, GitHub, and Nous (yes), Google (only through its own CLI), and Anthropic (no — API key, or Claude Code in a terminal). The lanes are built to swap when those answers change.

## 5. Feature specs

### 5.0 UI/UX system: OpenCode × Slack × Cursor × Plane

The reference set is deliberate. Each of the four owns one surface Perch needs; Perch's job is to make them feel like one product.

| Source | Take | Leave |
|---|---|---|
| **OpenCode** | Session-first transcript as the primary object; plan/build modes; inline permission prompts; collapsed tool cards; `/` commands; model picker in the composer; minimal chrome; monospace-forward; instant feel | TUI-only ergonomics; single-user assumptions |
| **Slack** | Rail → sidebar → main → thread panel; sidebar sections with unread weight; channel header (topic, pins, members, bots); hover toolbar; threads; reactions; the composer; Activity, Later, DMs; search; presence and typing; interactive messages; workspace switcher | Huddles, canvases, workflow builder, the "More" menu sprawl |
| **Cursor** | Right-side agent panel with modes; `@` context chips; inline diff review with accept/reject per file and per hunk; ⌘K inline edit on a selection; checkpoints per turn; an Agents list for background work; in-editor browser; Apply on code blocks | Forking VS Code; the extension marketplace; the settings maze |
| **Plane** | Work siderail → projects sidebar → work items; five layouts; the work item detail page with grouped properties and activity tabs; peek overlay; cycles, modules, saved views, intake; Linear-style single-key shortcuts; command menu; custom themes and density | Initiatives, teamspaces, dashboards, time tracking, customers (not before Phase 5) |

**The shell.** One layout, five regions, content swaps by mode. Rail + sidebar + main are visible by default; the panel opens for a thread, a session, or an item's properties; the drawer toggles. Widths and open state are remembered per mode.

```
┌──┬─────────────┬───────────────────────────────┬───────────────┐
│  │  Sidebar    │  Main                         │  Panel        │
│R │  context    │  channel · editor + preview · │  thread ·     │
│a │  list for   │  board · session · forge      │  session ·    │
│i │  the mode   │                               │  properties   │
│l │             ├───────────────────────────────┤               │
│  │             │  Drawer: terminal · console · git · problems  │
└──┴─────────────┴───────────────────────────────┴───────────────┘
```

| Rail tab | Sidebar | Main | Panel | Drawer |
|---|---|---|---|---|
| **Home** (Slack) | Channels, DMs, Bots, Later | Channel or DM | Thread | — |
| **Code** (Cursor + OpenCode) | Projects → file tree, sessions, previews | Editor tabs, session transcript, or Preview | Agent session or thread | Terminal, console, git, problems |
| **Work** (Plane) | Projects, cycles, modules, views, intake | List, board, calendar, timeline, or spreadsheet | Work item properties + activity | — |
| **Bots** | Bots, templates, skills, connections | Forge editor with live test chat | Run log or spec | — |
| **Inbox** | Needs you, mentions, threads, later | Approvals + activity feed | The item: permission, PR, preflight, chain | — |
| **Search** | Filters | Results across messages, code, items, sessions | Peek | — |

Workspace switcher at the top of the rail, avatar and settings at the bottom. The rail is the only navigation that never changes.

**Peek everywhere (Plane).** Work items, sessions, PRs, previews, and bots open as a peek overlay from any context — a chat message, a board card, an inbox row — with "Open full." You never lose your place. Every object has a stable URL, a `perch://` deep link, and an identifier (`NEST-123`, `session:8f2`, `pr:42`) that unfurls when pasted.

**Cross-mode links (the glue).** Message → work item ("Create work item" on the hover toolbar). Work item → session ("Start session", pick an engine). Session → thread (`/share` posts a live session card). Diff card → editor. Preview share → thread. PR → work item. Bot chain → chain header on the thread with hops, cost, and breaker state (§5.8). This is the product: the four references linked so tightly that moving between them feels like scrolling.

**One composer.** The same component in channels, threads, DMs, sessions, and work item comments: Markdown with a formatting toolbar, `@` for people, bots, and groups, `#` for channels, `[[` for work items and files, `/` for commands, emoji, attachments and pasted images, code blocks, drafts that persist. In session mode it grows the OpenCode and Cursor controls: model picker, plan/build/ask, reasoning level, permission mode, and `@file @folder @codebase @web @docs` context chips. Enter sends; Shift+Enter is a newline; Esc cancels a running turn.

**Editor and review (Cursor).** Editor group with tabs and breadcrumbs, minimap off. Inline diff decorations with gutter markers; a file-level Accept all / Reject all bar; hunk-level accept and reject; per-turn and cumulative diffs; Restore checkpoint on any turn; ⌘K inline edit on a selection with the diff shown in place; Apply on code blocks in chat; Problems from LSP and preflight in the drawer. Tab completion is optional and off by default.

**Work (Plane).** Work items with types, states (including the agent-specific "Needs you"), priority, assignee (human, bot, or engine + model), labels, cycle, module, estimate, due date, sub-items, relations, and links. Five layouts and saved views with display properties. The detail page: Tiptap description, grouped properties, and activity tabs (comments, activity, sessions, diffs) — bots comment there too. Intake triages anything from outside. Quick-add parses natural language: `fix login redirect @dawn p1 cycle:12` becomes an item. Pages later, in Plane's shape.

**Bots in the UI.** BOT badge, model chip, cost on hover for admins, typing indicator while working, a placeholder edited into the final reply, "working on" presence, and the chain header on any thread where bots tagged each other.

**Mobile (Slack and Plane mobile).** Bottom tab bar (Home, Work, Inbox, Code, More); main only; sidebar as a sheet; panel pushes; sticky composer; swipe to reply; long-press for actions; Code opens on the session pane; Preview is full-screen with tap-to-select; Work defaults to the list layout with quick-add; Inbox is the launch tab whenever something needs you.

**Keyboard map.** ⌘K opens the command palette everywhere (navigate, create, run actions, switch model) — except inside a focused editor with a selection, where ⌘K is inline edit, as in Cursor. Then: Plane and Linear style single keys on any list or board (`C` create, `A` assign, `S` state, `P` priority, `L` label, `E` edit, `Space` peek); Slack keys in chat (`⌘⇧A` unreads, `⌘G` search, `⌘.` toggle panel, `↑` edit your last message, `⌘⇧D` DMs); Cursor keys in Code (`⌘I` agent panel, `⌘L` new session, `⌘J` drawer, `⌘B` sidebar, `⌘⇧C` inspector, `⌘⇧P` preview); OpenCode commands in any session (`/plan`, `/build`, `/model`, `/undo`, `/compact`, `Esc` to cancel). All rebindable; the palette shows every binding.

**Visual system.** Dark-first with a light theme and custom themes (Plane); compact and comfortable density. A neutral surface scale (base, surface, raised, overlay) and one accent. Semantic color only where it means something: diff add and remove, work item states, the BOT badge, permission amber, error red. Typography: a UI sans (Inter or Geist) at 13 px compact / 14 px comfortable, and a monospace (JetBrains Mono) for code, transcripts, tool cards, and identifiers. Lucide icons, 6 px radius, 1 px hairline borders, minimal shadows, 120–180 ms motion, reduced-motion honored. Tokens live in `packages/ui/tokens` as CSS variables; a theme is a token set; the community can ship themes through the Hub.

**Components (`packages/ui`).** shadcn/ui as the base, plus Perch's own: Shell, Rail, Sidebar, Panel, Drawer, CommandPalette, Composer, MessageList (virtualized), Thread, BlockRenderer (interactive blocks), SessionTranscript, ToolCard, PermissionPrompt, DiffView, EditorGroup, TerminalDrawer, PreviewFrame, InspectorPanel, Board, ListView, CalendarView, TimelineView, SpreadsheetView, WorkItemPeek, PropertiesPanel, IntakeQueue, InboxList, ChainHeader, BotBadge, Peek.

**States.** First run lands in a demo workspace with a sample project, three bots, and a guided tour. Empty channel suggests bots to add; empty project offers clone or create; empty board offers "create from a thread"; empty inbox says so in one line.

**Accessibility and performance.** Keyboard-complete with visible focus; landmarks per region; live regions for streaming transcripts; labeled diff hunks ("3 lines added"); AA contrast; 44 px touch targets on mobile. Virtualized lists everywhere; streaming render batched to the frame; cold start under 2 s on a laptop; route transitions under 100 ms; a WebSocket payload budget checked in CI (the T3 lesson).

**What is not copied.** No VS Code fork. No Slack "More" sprawl. No Plane initiatives, teamspaces, or dashboards before Phase 5. No Cursor settings maze. Every screen has to trace to one of the four references or to the wedge, or it doesn't ship.

### 5.1 Perch IDE

- **Projects:** empty, upload/zip, or git clone (HTTPS token or per-workspace SSH deploy key). Lives on a project volume inside the workspace runner. Many projects per workspace.
- **Layout:** the Code mode of the shell (§5.0): sidebar = projects → file tree, sessions, previews; main = editor tabs, session transcript, or **Preview**; panel = the agent session (Cursor-style) or a chat thread; drawer = terminal, console, git, problems. Everything toggles from ⌘K. Preview can split with the session pane so you watch the app change while the agent works.
- **Editor:** CodeMirror 6 — highlighting for ~40 languages, search/replace, multi-cursor, bracket and indent handling, markdown and image preview. Cursor's review surfaces: inline diff decorations with gutter markers, a file-level Accept all / Reject all bar, hunk-level accept and reject, **⌘K inline edit** (select code, type an instruction, review the diff in place), Apply buttons on code blocks in chat, and a Restore-checkpoint action per turn. Diagnostics and hover via OpenCode's LSP integration where available; otherwise no LSP in v1. Tab completion is optional and off by default (a local coder model can serve it).
- **Terminal:** xterm.js ↔ node-pty in the runner, per user, persistent across reloads (tmux underneath). Official CLIs preinstalled (Lane C). File paths in output open in the editor.
- **Agent session pane (the OpenCode part):**
  - Prompt box with `@file` and `@folder` mentions, image paste, a reasoning-effort control, slash commands: `/plan`, `/build`, `/model`, `/undo`, `/redo`, `/compact`, `/share`.
  - Streaming transcript: text, tool-call cards (collapsed by default), permission prompts (Allow once / Always this session / Deny), usage and cost footer.
  - Diff review, per turn and cumulative: each turn's diff in unified or split view as it lands, plus the whole-session diff; file list with +/− counts, per-hunk accept or reject, "Open in editor", "Revert all".
  - Quick actions: run commands from `.perch/project.json` (`test`, `dev`, `lint`), plus **custom actions** — per-project buttons that run a command or a saved prompt (`Fix lint`, `Write changelog`), checked in and shared.
  - Background policy per project: what may run unattended, what waits for you, and whether finished turns auto-settle.
  - Session list per project: resume, fork, rename. `/share` posts a live session card into a chat thread.
- **Git panel:** status, stage/unstage, AI commit message (uses the session model), branch switch, push, "Open PR" via GitHub or GitLab token (optional). **Pull Requests page** (Phase 3): PRs across connected GitHub and GitLab repos, inline comments, request changes, "ask the agent to address review."
- **Config:** `.perch/project.json` — default engine, default model profile, permission policy, run commands, env file pointer, and `preview` (dev command, port, path, routes to smoke-test). One checked-in file; everything else is defaults.
- **Mobile:** session pane and chat are first-class; the editor is read-mostly on phones with a "quick edit" sheet.

### 5.2 Perch Chat

- **Structure:** workspace → channels (public/private), DMs (1:1 and group), threads. Navigation is Slack's: workspace switcher on the rail; sidebar sections (Channels, DMs, Bots, Later) with unread weight and section collapse; channel header with topic, pins, members, and the bots present; hover toolbar on messages (react, reply, create work item, share to session, more); the thread in the panel with "also send to channel"; Activity folded into the Inbox. Mentions (`@user`, `@bot`, `@group`, `@channel`), reactions, pins, bookmarks (Later), edit and delete with history, read state and unread badges, presence and typing, mute and notification prefs, web push.
- **Content:** Markdown, code blocks with highlighting and "Open in IDE", file uploads with previews (images, PDFs, video), link unfurls (optional), emoji picker, `/` commands.
- **Message blocks (jsonb):** `text`, `code`, `diff_card`, `session_card` (live status of a coding session), `tool_card`, `file`, and **interactive blocks** — `button`, `select`, `form` (opens a modal), `approve_deny`, `progress`. Interactions post a payload to the owning bot over the Bot API (`interaction.received` with block id, values, user, message) and update the block in place. `poll` later.
- **Search:** Postgres full-text over messages and file names; filters by channel, author, date, `has:code`.
- **Bots as members:** join and leave like humans, same channel permissions, BOT badge, model used and cost on hover for admins, per-bot rate limit. Bot replies thread by default to keep channels calm.
- **Bot chat:** a DM with a bot. "New chat" starts a fresh thread (fresh context) inside the DM. Model picker per DM when the bot's spec allows overrides. `@grok explain this thread` from any thread → the bot replies in-thread with the thread as context.
- **Keyboard:** ⌘K everywhere; Slack-familiar shortcuts (⌘⇧A unreads, ↑ edits your last message).
- **Not in v1:** federation, voice/video, E2EE, guest accounts, huddles.

### 5.3 Bot Forge

Every bot has: identity (name, handle, avatar), persona (system prompt, style, language), brain (model profile or "user's choice"), tools (allow-list), triggers, scope (channels, DMs, projects), memory policy, budget and rate limit, owner, visibility.

Four ways to make one:

1. **Forge UI (no-code).** Form + live test chat + templates: *Grok Newsroom*, *GPT Helpdesk*, *Claude Reviewer (API key)*, *Local Llama*, *12birb Editor*, *GAM3 TALK Show Notes*. Publish to channels in two clicks.
2. **Spec bots (YAML).** `bots/<handle>/bot.yaml` + `SYSTEM.md` + `skills/`. Same YAML-frontmatter + markdown skill format The Nest already uses, so existing skills drop straight in. Lives in a repo; hot-reloads on push.
3. **Code bots (TypeScript).** `export default bot({ onMessage, onSchedule, onWebhook })` with `@perch/bot-sdk`. Runs in a QuickJS (WASM) sandbox with no host access unless a tool is granted, or in a runner container for heavy jobs.
4. **External bots (Bot API).** Slack-shaped: create bot → token → REST + events. How Hermes and Nest agents, cron scripts, or anything else join.

**Bot API v1 (Slack-shaped on purpose; Hermes already ships Slack/Discord/Telegram gateways, so the adapter is thin):**

- `POST /api/v1/chat.postMessage` — `{ channel, text | blocks, thread_ts? }`
- `GET /api/v1/conversations.list` · `conversations.history` · `users.info`
- `POST /api/v1/files.upload`
- Events over WebSocket (socket mode) or webhook: `message.created`, `app_mention`, `reaction.added`, `channel.joined`, `session.completed`, `interaction.received`. Every `app_mention` carries `mentioned_by` (`user` or `bot` plus id), `mode` (`consult`, `handoff`, `fanout`), `root_id` (the originating human request), `hop`, and the remaining thread budget, so external bots can take part in bot-to-bot chains under the same rails as native ones (§5.8)
- Scopes: `chat:write`, `channels:read`, `files:write`, `sessions:open`. Per-bot rate limits.

**Triggers:** DM, mention, keyword or regex, channel join, schedule (cron), inbound webhook, session events, reaction (📌 → summarize).

**Tools (native runtime):** `web_search` (pluggable: xAI Live Search, Brave, Firecrawl, Nous Tool Gateway), `http_fetch`, `sandbox_exec` (short-lived container, no network by default), `repo_read` / `repo_search` (read-only project files), `chat_post` / `chat_read`, `mention` / `wait_for_replies` / `hand_off` (bot-to-bot collaboration, §5.8), `thread_facts` (shared scratchpad per thread), `open_session` (agent bots), `remember` / `recall` (pgvector), `image_generate` (Nous gateway or provider), plus **MCP**: attach any MCP server to a bot, reusing OpenCode or Hermes MCP configs.

**Guardrails:** bots see only channels they're in; tool outputs and web content are wrapped as untrusted; no secrets in bot context; per-bot budgets and a kill switch; audit log of every model call; write-tools require a permission prompt in shared channels by default.

```yaml
# bots/grok/bot.yaml
handle: grok
name: Grok
avatar: ./avatar.png
brain:
  model: xai/grok-4.3        # a model_profile from the registry
  temperature: 0.7
persona: ./SYSTEM.md
tools: [web_search, http_fetch]
triggers:
  - dm
  - mention
  - schedule: "0 9 * * 1-5"  # weekday 9am
    prompt: "Post today's gaming + crypto headlines to #newsroom"
scope:
  channels: [newsroom, general]
memory:
  window: 30
  long_term: false
budget:
  daily_usd: 5
```

### 5.4 Agent bots and The Nest

- **Agent bot** = a bot spec with `engine: opencode` (or `hermes`) plus `projects: [...]`. From any channel: `@dawn add a dark-mode toggle to the magazine site` → Dawn opens a session on that project, posts a `session_card` in the thread (live status), asks permissions in-thread, and finishes with a `diff_card`, "Open in IDE", and an optional PR link.
- **Nest members:** each Nest agent registers via the Bot API (or the `hermes` adapter) with its existing persona and skills. Birbus can dispatch to Dawn, Julius, or Paige inside a Perch thread, so orchestration becomes visible and interruptible from a phone.
- **Gateway for the Nest:** point the agents' OpenAI-compatible provider at Perch's `/v1` with a workspace virtual key. One place for keys, budgets, and usage across all 19 agents.
- **Roost tie-in:** the content-pipeline bots (magazine, newsletter, comic, GAM3 TALK show notes) run as Perch bots in `#newsroom`, `#magazine`, `#comic`.

### 5.5 Connections: first-party connectors

Settings → Connections shows a card per service with **Connect** (OAuth), **Paste token**, or **Use my own app** (BYO client), a "Test connection" button, granted scopes, expiry, and a per-connection tool allow-list. Auth lanes below were verified September 2026.

| Service | Auth lanes | What it powers |
|---|---|---|
| **GitHub** | **GitHub App** (recommended: install on org or repos → short-lived installation tokens, webhooks, check runs); OAuth App for user identity; fine-grained PAT fallback. GitHub's remote MCP server does not support DCR (open issue as of May 2026), so it is PAT-in-header or your own registered app; Perch ships a GitHub App wizard with the callback and webhook URLs prefilled. | Clone and push (Phase 1), "Open PR" from a diff card, issue → task, Actions status in threads, `@dawn` opens PRs, GitHub MCP tools for agents |
| **Vercel** | Vercel MCP (`https://mcp.vercel.com`, OAuth); team or personal token fallback | **Deploy** button (git-based deploy or `vercel deploy` from the runner), preview-URL cards in threads, build and runtime logs → thread, runtime-error alerts → `#alerts`, env-var changes behind a permission prompt, analytics summaries from bots |
| **Supabase** | Supabase MCP (`https://mcp.supabase.com/mcp`, OAuth 2.1 with DCR); manual OAuth app fallback; PAT fallback. Shared-bot defaults: project-scoped, read-only, restricted feature groups | Schema and table browser in the IDE side panel, SQL with a permission prompt for writes, migrations from coding sessions, edge-function deploys, advisor (security and performance) findings → channel, branch workflows |
| **Clerk** | Clerk MCP (`https://mcp.clerk.com/mcp`, OAuth; Clerk supports CIMD in beta and DCR); secret-key fallback | User and org lookup for support bots, session and user management behind prompts, SDK snippets inside coding sessions. Also **Clerk as Perch's login**: better-auth generic OIDC against a Clerk OAuth application, for teams that already run identity on Clerk |
| **Everything else** | Declarative manifests: `connectors/<provider>/manifest.yaml` (auth type, endpoints, scopes, refresh rules, API base, optional MCP URL, webhook signature scheme). Seed list: Google Workspace, Slack, Discord, Notion, Linear, Jira, Sentry, Cloudflare, Railway, Netlify, Stripe, HeyGen, X | Community-contributable. Index published as `connectors.json` in the repo (models.dev-style); admins can add custom manifest URLs |

### 5.6 Preview browser and visual inspector

The dev server runs inside the workspace runner. The Preview tab shows it from any device, and an Elements-style inspector maps whatever you click back to source, so you can change it on the spot or hand it to the agent — before anything is pushed.

**Preview proxy**

- Every listening port in a runner becomes a URL: `https://5173--<workspace>.preview.<domain>`. Wildcard DNS plus a wildcard cert (Caddy DNS challenge, or the cloudflared wildcard route). Path-based fallback `/p/<workspace>/<port>/` for installs without wildcard DNS; base-path caveats documented.
- Gated by the Perch session on the parent domain. WebSocket passthrough so HMR and live reload work. Cookies and service workers stay scoped to the preview origin.
- **Auto-detect:** the runner watches listening ports and terminal output (`Local: http://localhost:5173`) → toast "Dev server on :5173 — Open preview". `.perch/project.json` can pin it: `"preview": { "command": "pnpm dev", "port": 5173, "path": "/", "routes": ["/", "/pricing"] }`. The Preview tab's Start button runs the command in a terminal.
- **Share:** "Share preview" posts a live link card into a thread: expiring, revocable, optionally public, never with the inspector injected. Once the branch is pushed, the card shows the Vercel preview deployment beside it for comparison.

**Preview pane** (a main-pane tab next to editor tabs, or split with the session pane)

- URL bar for in-app routes, back/forward/reload, viewport presets (phone, tablet, desktop, custom), rotate, DPR, dark/light and reduced-motion emulation, open in new tab.
- Bottom strip: console errors, warnings, and logs plus failed requests, each with "Send to agent"; or toggle "auto-attach to next prompt".
- Screenshot button: headless Chromium in the runner captures the same URL at the same viewport → attach to the prompt or post to a thread.
- On a phone: full-screen preview with tap-to-select. Checking a build from the couch is the point.

**Inspector** (toggle ⌘⇧C)

- Injected by the proxy only for authenticated preview-pane requests: a ~15 KB script added before `</head>` on HTML responses, talking to the IDE over `postMessage` (origin-checked, nonce-bound).
- Hover highlight with tag, size, and a source badge; click to select; an Elements tree you can expand and collapse; a panel showing text, attributes, classes (Tailwind-aware), computed box model, and the component chain.
- **Source mapping:** the `@perch/inspector` dev plugin (Vite, Next, Nuxt, Astro, Webpack and Rspack, SvelteKit, Solid; wraps the `code-inspector-plugin` approach) tags elements in dev builds with `data-perch-src="src/components/Button.tsx:42:7"`. Fallbacks: framework devtools hooks where a debug source is exposed, then text and class search across the project. "Open source" jumps to file:line in the editor with the element's markup highlighted.
- **Select → describe (Phase 2):** the selected element becomes a context chip in the session prompt (`<Button> · src/components/Button.tsx:42 · classes · text`). "Make this primary and larger" → the agent edits the right file, HMR reloads, and the element re-selects itself after reload. Multi-select for "these three cards".
- **Direct tweaks (Phase 3):** edit text, class list, and common CSS (spacing, color, typography) in the panel. Applied to the DOM instantly for feel, then written to source through a deterministic `apply_element_edit` tool at the tagged location, shown as a diff card you accept or reject. Tailwind projects get class autocomplete; CSS projects get the rule edited in place.

**The agent gets eyes too**

- `@playwright/mcp` runs in the runner and attaches to coding sessions whenever a preview is open: navigate, accessibility snapshot, screenshot, click, read console. The agent verifies its own change against the preview before it says "done".
- **Preflight before push:** one action runs `test`, `lint`, and `build` from `project.json`, then an agent visual smoke (visit the routes you listed, screenshot each, fail on console errors) and posts a checklist card. Configurable: warn or block the push.

**Security**

- The proxy reaches only ports inside the user's own workspace runner; per-workspace network isolation; no proxying to arbitrary hosts.
- Inspector injection only when the request carries the preview-pane nonce; shared and public links get a clean page; CSP is relaxed only for the injected script and only on authenticated preview responses.
- The `postMessage` channel verifies both origins; the preview iframe runs with the minimum sandbox flags that keep the app functional.
- Share links use expiring tokens, are revocable from the card, and are audit-logged.

**Not in v1:** screen-streaming a full remote browser, non-web app previews beyond Expo web and Storybook (both are just another port), and an API request runner (later).

### 5.7 The agent loop: tasks, worktrees, inbox, policy

This is the wedge (PERCH-COMPETITIVE-GAPS.md §2): the loop nobody ships end-to-end, self-hosted, with any agent and any model.

- **Work (the tasks board, modeled on Plane).** Work items with identifiers (`NEST-123`), types (task, bug, feature, epic), states (Backlog, Queued, Running, Needs you, In review, Done, Cancelled), priority, assignee (human, bot, or engine + model), labels, cycle, module, estimate, due date, parent and sub-items, relations, and links to the thread, session, PR, and preview. Five layouts: list, board, calendar, timeline, spreadsheet; saved views with filters and display properties; cycles with burndown and agent throughput; modules as thematic groups; **Intake** as the triage queue for anything that arrives from outside (webhooks, bot-proposed items, cron) with accept, decline, or convert. Items arrive from chat (`/task`, a reaction, `@dawn do X`, "Create work item" on any message), the board, inbound webhooks (GitHub issue, Sentry alert), or cron. Minimal on purpose: Linear and Jira stay the system of record for teams that have one (connector two-way sync).
- **Worktree per task.** Every session runs in its own git worktree and branch (`perch/<task-id>`), so N agents work in parallel on one repo without stepping on each other. Merge queue with rebase, conflict detection, and "ask the agent to resolve." Cleanup on close.
- **Race mode.** Run the same task on two engines or models side by side; compare diffs, cost, and preflight results; pick a winner; the loser's branch is discarded. Results feed the eval board.
- **Background by default.** Sessions keep running when you close the tab or the laptop; every state change posts to the task's thread; the phone gets the ones that need you.
- **Approval inbox.** One queue across the workspace: permission prompts, preflight results, PRs awaiting review, budget alerts, failed bot runs. Batch approve, snooze, delegate. Push to phone. Built on interactive blocks, so the same card works in a thread and in the inbox.
- **Policy engine.** Workspace and project rules evaluated before any agent action: protected branches, denied commands (`rm -rf`, `git push --force`, package publishes), path allow and deny lists, secret scanning on every agent diff before commit, per-channel and per-project **model allow-lists** ("this channel: local models only"), budget ceilings, and the bot-to-bot rails from §5.8 (who may tag whom, hop limits, per-thread budgets). Rules live in `.perch/policy.yaml` at the workspace and project level; violations show as a card with an override path for admins.
- **Project env and secrets.** Encrypted per-project env; import from the Vercel and Supabase connectors; injected into runner, previews, and sessions; never into a model context; optional Vault, 1Password, Infisical, and Doppler backends.
- **Repo intelligence.** Codebase index (symbols plus embeddings in pgvector) behind `@codebase`; semantic search across code, chat, and docs; generated repo docs and an AGENTS.md draft for new projects; cross-session project memory so the third session doesn't relearn the build system.
- **Testing loop.** Failing tests → bounded auto-fix loop with a budget; CI status webhook → agent retry; flaky-test detection.
- **Agent presence.** Busy/idle status, "working on" cards, an agent org view (Birbus → Dawn, Julius, Paige, Kimi), assignment from chat.

### 5.8 Bots tagging bots: collaboration through mentions

Yes: the same Slack-shaped chat is the integration bus for every bot, and a mention is the collaboration primitive. Any member, human or bot, can `@mention` any bot; a mention is a message event that triggers the mentioned bot with the thread as its context. Bot-to-bot mentions are on by default inside a workspace and governed by the same policy engine as everything else.

**How a chain runs**

1. A human (or a webhook, cron, or task card) starts a thread: `@birbus ship the newsletter for Friday`.
2. Birbus replies in the thread and tags specialists: `@julius pull this week's top stories` `@paige draft the intro` `@dawn update the template`. Each tagged bot receives an `app_mention` with the windowed thread transcript, the thread facts, `mentioned_by`, `mode`, `root_id`, `hop`, and the remaining budget.
3. Each bot works with **its own** brain, tools, grants, and credentials. Nothing is inherited from the bot that tagged it; a bot cannot grant another bot a tool or a connection.
4. Replies land in the same thread, attributed (avatar, BOT badge, model, cost on hover). Humans watch it live and can reply at any point to redirect; `/stop` halts every bot in the thread; `/resume` continues.
5. The orchestrator collects results (`wait_for_replies`), posts the outcome, and, for agent bots, the diff card or PR link.

**Three mention modes** (the tagging bot chooses; humans don't need to think about it)

- **Consult** — `@julius what does the docs say?` The tagged bot answers in the thread; control returns to the asker.
- **Handoff** — `@dawn take this from here`. The task card reassigns; the original bot stops; the new bot owns the thread until it hands off again or finishes.
- **Fan-out** — several bots tagged in one message run in parallel; the asker waits for all, or for the first, or for a quorum.

**Rails that keep it from melting down**

- **Hop limit** per root request (default 6 bot-to-bot hops), no self-mention, repeat-pair detection (A→B→A→B trips the breaker), and a per-thread budget in tokens and dollars inherited from the root request and split across hops.
- **Circuit breaker:** when a limit trips, the thread pauses and an "intervene" card lands in the inbox with the chain so far, the cost, and Continue / Stop buttons.
- **Trust boundary:** a message from another bot is data, not privileged instruction. Each bot's own persona and policy govern; content from bots outside the workspace's trusted list (typically just the orchestrators) is wrapped as untrusted the same way web content is.
- **Scope controls in `policy.yaml`:** which bots may tag which (allow-lists), which channels permit bot-to-bot chatter, whether bot-to-bot DMs are allowed (off by default so every chain stays visible in a channel thread), and the hop and budget defaults.
- **Audit:** every hop is logged with `root_id`, from-bot, to-bot, mode, tokens, cost, and outcome. The eval board reads it.

**Shared state**

- The thread is the shared memory: every bot gets the windowed transcript, attachments, diffs, and session cards.
- **Thread facts** is a structured scratchpad any bot in the thread can read and update (`thread_facts` tool): decisions, links, numbers. Pinned at the top of the thread for humans too.
- Task cards carry ownership, status, and the worktree; an orchestrator's fan-out shows up as subtasks on the board.

**Orchestrators**

A bot flagged `orchestrator: true` can create tasks, fan out, wait, summarize, and reassign. That is Birbus running The Nest in the open — Dawn, Julius, Paige, and Kimi as members, the whole dispatch visible and interruptible from a phone. Group handles (`@newsroom-crew`) expand to their members; `@here` and `@channel` never trigger bots.

**Parity for every bot type**

Native bots get mentions as prompts with tools; spec and code bots through the SDK; external bots through the Bot API event; Nest agents through the Hermes adapter; coding agents through their agent-bot wrapper. A bot posting `<@dawn>` through `chat.postMessage` triggers exactly the same path as a human typing it.

**Presence and noise**

Bots show a typing indicator while working, edit a placeholder into the final reply instead of spamming, and always reply in-thread. Channels stay readable; the thread holds the work.

## 6. Data model (normative)

Conventions: every table has `id uuid` (v7, time-ordered) as primary key, `created_at` and `updated_at timestamptz`; every tenant-scoped table has `workspace_id` with a composite index on (`workspace_id`, the natural lookup); enums are `text` with check constraints (portable to PGlite); `?` marks nullable; `jsonb` shapes are Zod schemas in `packages/db/src/shapes`. better-auth owns its own tables (`auth_user`, `auth_session`, `auth_account`, `auth_passkey`, `auth_verification`) through the Drizzle adapter; `users` below is Perch's profile row keyed 1:1 to `auth_user`. Embeddings are 1024-dimensional everywhere (providers are asked for `dimensions: 1024`; default profiles are OpenAI `text-embedding-3-small` at 1024 and local `mxbai-embed-large`). Soft delete only where noted.

```
# identity and tenancy
users               auth_user_id text unique, email citext unique, name text, handle citext unique, avatar_file_id uuid?, locale text default 'en', tz text
workspaces          slug citext unique, name text, settings jsonb, plan text default 'self-hosted'
memberships         workspace_id, user_id, role text check in (owner, admin, member), unique(workspace_id, user_id)
invites             workspace_id, email citext, role text, token_hash text unique, expires_at, accepted_at?
api_tokens          user_id, workspace_id?, name text, token_hash text unique, scopes jsonb, last_used_at?, expires_at?
instance_settings   key text pk, value jsonb            # PERCH_PUBLIC_URL overrides, telemetry opt-in, feature flags

# projects and runners
projects            workspace_id, key citext, name text, repo_url text?, default_branch text, default_engine text, default_model_profile_id uuid?, runner_policy jsonb, config jsonb  # unique(workspace_id, key)
runners             workspace_id, kind text check in (hosted, local, remote), owner_user_id uuid?, name text, status text, capabilities jsonb, last_seen_at?, container_id text?
runner_tokens       runner_id, token_hash text unique, expires_at, revoked_at?
project_env         project_id, key text, ciphertext bytea, source text check in (manual, vercel, supabase, vault), unique(project_id, key)
policies            workspace_id, project_id uuid?, rules jsonb, version int, updated_by uuid
preview_shares      workspace_id, project_id, runner_id, port int, path text, token_hash text unique, public bool, expires_at, created_by uuid, revoked_at?

# chat
channels            workspace_id, type text check in (public, private, dm, group, item), name citext?, topic text?, project_id uuid?, archived_at?   # unique(workspace_id, name) where name not null
channel_members     channel_id, member_type text check in (user, bot), member_id uuid, role text, joined_at, unique(channel_id, member_type, member_id)
messages            workspace_id, channel_id, thread_root_id uuid?, author_type text check in (user, bot, system), author_id uuid, blocks jsonb, text_search tsvector generated, reply_count int, edited_at?, deleted_at?
                    idx (channel_id, created_at desc), (thread_root_id, created_at), gin(text_search)
message_reactions   message_id, member_type, member_id, emoji text, unique(message_id, member_type, member_id, emoji)
pins                channel_id, message_id, pinned_by uuid, unique(channel_id, message_id)
bookmarks           user_id, message_id, note text?, unique(user_id, message_id)
read_state          user_id, channel_id, last_read_message_id uuid?, mention_count int, unique(user_id, channel_id)
thread_facts        thread_root_id, key text, value jsonb, updated_by_type text, updated_by_id uuid, unique(thread_root_id, key)
files               workspace_id, uploader_type text, uploader_id uuid, storage_key text unique, name text, mime text, size bigint, sha256 text, preview_key text?, deleted_at?
notifications       user_id, kind text, payload jsonb, read_at?, idx (user_id, created_at desc)

# bots
bots                workspace_id, handle citext, name text, level text check in (ui, spec, code, external), spec jsonb, owner_id uuid, visibility text check in (private, workspace), orchestrator bool, budget jsonb, status text, unique(workspace_id, handle)
bot_installs        bot_id, channel_id, scopes jsonb, obo bool, unique(bot_id, channel_id)
bot_runs            workspace_id, bot_id, trigger text, trigger_ref uuid?, status text, engine text?, model_id text?, input_tokens int, output_tokens int, cost_usd numeric(12,6), started_at, ended_at?, error text?
bot_chains          workspace_id, root_message_id uuid, thread_root_id uuid, hop int, from_type text, from_id uuid, to_bot_id uuid, mode text check in (consult, handoff, fanout), status text, tokens int, cost_usd numeric(12,6), breaker_reason text?
bot_memories        bot_id, scope text, content text, embedding vector(1024), metadata jsonb, hnsw(embedding)

# brains
provider_credentials  workspace_id, scope text check in (user, workspace), owner_id uuid, provider text, kind text check in (api_key, endpoint, oauth_ref), ciphertext bytea, label text, base_url text?, status text
model_profiles        workspace_id, name text, provider text, model_id text, credential_id uuid?, params jsonb, tool_policy jsonb, cost_cap jsonb, default_for text?, unique(workspace_id, name)
virtual_keys          workspace_id, subject_type text check in (user, bot, runner, external), subject_id uuid, key_hash text unique, prefix text, budget jsonb, expires_at?, revoked_at?
usage_events          workspace_id, actor_type text, actor_id uuid, session_id uuid?, bot_run_id uuid?, model_id text, provider text, input_tokens int, output_tokens int, cached_tokens int, cost_usd numeric(12,6), ts timestamptz, idx (workspace_id, ts desc)

# engines and sessions
coding_sessions     workspace_id, project_id, runner_id, user_id, engine text, engine_session_id text?, model_profile_id uuid?, mode text, status text, worktree text?, branch text?, work_item_id uuid?, thread_root_id uuid?, cost_usd numeric(12,6), started_at, ended_at?
session_events      session_id, seq bigint, event jsonb, ts, unique(session_id, seq)         # replayable transcript
session_checkpoints session_id, turn int, git_ref text, created_at

# connections
connections         workspace_id, owner_type text check in (user, workspace), owner_id uuid, provider text, kind text check in (mcp_oauth, oauth2, github_app, token), ciphertext bytea, scopes jsonb, expires_at?, status text, metadata jsonb, last_refreshed_at?
connection_grants   connection_id, subject_type text check in (bot, automation, session), subject_id uuid, allowed_tools jsonb, channels jsonb, obo bool, granted_by uuid
oauth_clients       workspace_id?, provider text, client_id text, ciphertext_secret bytea?, redirect_uri text, unique(workspace_id, provider)
mcp_servers         workspace_id, connection_id uuid?, runner_id uuid?, name text, url text?, transport text check in (http, stdio), command jsonb?, tool_cache jsonb, last_synced_at?
inbound_webhooks    workspace_id, provider text, secret_hash text, route jsonb, filters jsonb, enabled bool
outbound_webhooks   workspace_id, url text, events jsonb, secret_hash text, enabled bool

# work (Plane-shaped)
work_items          workspace_id, project_id, number int, type text, title text, description jsonb, state text check in (backlog, queued, running, needs_you, in_review, done, cancelled), priority int, assignee_type text?, assignee_id uuid?, labels jsonb, cycle_id uuid?, module_id uuid?, estimate numeric?, due_at?, parent_id uuid?, source text, intake_status text?, thread_root_id uuid?, session_id uuid?, pr_url text?, preview_share_id uuid?, unique(project_id, number)
cycles              project_id, name text, starts_at, ends_at, status text
modules             project_id, name text, description text?, starts_at?, ends_at?
work_item_relations work_item_id, related_id, kind text check in (blocks, blocked_by, relates, duplicates), unique(work_item_id, related_id, kind)
saved_views         workspace_id, project_id uuid?, owner_id uuid?, name text, layout text, filters jsonb, display jsonb, shared bool

# inbox, audit, jobs, repo intelligence
inbox_items         workspace_id, user_id, kind text check in (permission, preflight, pr, budget, bot_failure, chain, intake, mention), ref_type text, ref_id uuid, status text, snoozed_until?, resolved_at?, idx (user_id, status, created_at desc)
audit_log           workspace_id, actor_type text, actor_id uuid?, action text, target_type text, target_id uuid?, details jsonb, ip inet?, ts, idx (workspace_id, ts desc)
jobs                queue text, payload jsonb, run_at timestamptz, attempts int, max_attempts int, locked_by text?, locked_at?, last_error text?, cron text?, idx (queue, run_at) where locked_at is null
repo_index          project_id, commit_sha text, path text, chunk_no int, kind text check in (symbol, chunk, doc), symbol text?, content text, embedding vector(1024), text_search tsvector generated, unique(project_id, path, chunk_no, commit_sha), hnsw(embedding), gin(text_search)
```

## 7. Security and multi-tenancy

- Agent code never runs in `api`. Always runner containers with CPU, memory, and pid limits; no Docker socket inside runners; optional egress allow-list.
- Per-user home volumes hold CLI logins and dotfiles. Users on a shared host never see each other's credentials.
- RBAC: owner, admin, member (guest later). A bot's permissions never exceed its creator's.
- Secrets: envelope encryption, masked in UI and logs, never placed in a model context.
- Tool permissions mirror OpenCode's ask / allow / deny; conservative defaults in shared channels.
- Prompt-injection hygiene: chat content, web pages, and tool outputs are untrusted; write tools prompt; bots cannot read channels they aren't in.
- Connection tokens never reach engines, bots, models, or external agents. Every vendor call goes through the MCP gateway or a connector operation with a grant.
- Confused-deputy guard: Perch never forwards a caller's bearer token upstream. Each upstream call uses the connection's own delegated token.
- The CIMD document is served read-only from `PERCH_PUBLIC_URL`; metadata fetches are SSRF-safe; loopback redirect URIs are allowed only in single-user mode.
- `perch backup` (pg_dump + volumes) and `perch restore`, exercised in CI.
- Updates: bump one image tag; migrations run on boot.
- Host sizing: 4 vCPU / 8 GB for 3–5 users without local models; 16 GB plus a GPU for a 14B Ollama model; 50 GB+ disk; Ubuntu 24.04 + Docker.

## 8. Roadmap (solo builder + Claude Code + Nest agents; weeks are rough)

| Phase | Weeks | Scope | Exit criteria |
|---|---|---|---|
| **0 — Foundation** | 1–2 | Public repo from day one: LICENSE, README, CONTRIBUTING, SECURITY.md, the no-relicensing pledge, CI with multi-arch images to GHCR. Monorepo, compose, Caddy, auth, workspaces, DB, design system, `PERCH_PUBLIC_URL` + CIMD document + callback route. OpenAPI-first API with generated SDKs | Sign up → workspace → empty shell renders on phone and desktop; a stranger can `docker compose up` from the README |
| **1 — IDE core** | 3–6 | Projects, supervisor + runner lifecycle, file tree, editor, terminal, **ACP adapter** + OpenCode adapter + **`cli-harness`** (Codex, Claude Code, Gemini CLI headless modes), session pane with per-turn diffs and permissions, registry v1 (API keys + OpenAI-compatible endpoints + Ollama), `.perch/project.json`, AGENTS.md read, `devcontainer.json` support. Connections v1: vault, token paste, **GitHub App** connector (clone, push, PR), MCP gateway skeleton. **Preview v1:** port proxy with wildcard and path modes, auto-detect, Preview tab, viewport presets, share links. **Laptop mode** (`perch` binary + PGlite) | Clone via GitHub connection → ask for a change → watch it in the Preview tab from a phone → review diff → commit → PR, once on a paid key and once on Ollama; the same flow from `curl \| sh` with no Docker; Codex and Gemini CLI both work as engines through ACP |
| **2 — Chat** | 7–10 | Channels, DMs, threads, mentions, reactions, files, search, presence, push; **interactive blocks**; native bot runtime with bot-to-bot mentions, hop limits, and thread facts; Forge UI level 1; DM-a-bot with model picker; templates (Grok, GPT, Claude API, Local); bot `skills/` in the Agent Skills format. Connections v2: MCP OAuth (CIMD → DCR → BYO app), **Vercel, Supabase, Clerk** connectors, Deploy button, DB panel. **Inspector v1:** `@perch/inspector` plugin, Elements tree, select → describe, console → agent, screenshot to thread. **Approval inbox**, **policy engine v1**, **project env and secrets**, **repo index** (`@codebase`), **local runner** (`perch runner connect`, Environments page), custom actions, reasoning level, background policies | A team of three uses it daily; `@grok` answers in `#general`; a Vercel deploy from the IDE posts its preview URL in a thread; clicking a button in Preview and typing "make this primary" lands the right edit; a permission prompt is approved from the phone inbox; a channel pinned to local models refuses a cloud model |
| **3 — Bot platform + the loop** | 11–14 | Spec bots (YAML), code bots, Bot API + `tools.call` + grants + interaction payloads, inbound webhooks (GitHub, Vercel, Supabase → channels), cron, tools, MCP attach, agent bots that open sessions from chat, `hermes` adapter, Nest agents as members, orchestrator bots with handoff and fan-out, connector manifests + BYO OAuth wizard, Perch as an MCP server. **Tasks board, worktree per task, merge queue, race mode, background sessions, testing loop, agent presence, Pull Requests page with in-app review.** **Inspector v2:** direct tweaks with `apply_element_edit`, Playwright MCP for agents, preflight before push. Traces and cost per task (OTel) | `@dawn fix X` from chat ships a diff card and a PR; three agents work the same repo in parallel without conflicts; a race between two models picks a winner; a Nest agent posts via the Bot API using a granted Supabase connection; Birbus fans out to three specialists in one thread and the breaker stops a runaway pair; the agent screenshots its own change before reporting done |
| **4 — Gateway, hardening, launch** | 15–18 | `/v1` endpoint, virtual keys, budgets, usage dashboard, fallbacks, RBAC and audit, backups, setup wizard, Lane B/C polish (official CLIs in the runner image, per-user homes). Open-source launch: docs site, one-line installer, Homebrew, winget, AUR, and nix distribution, one-click templates (Coolify, Railway, Render, Fly), starter stacks + demo workspace, security scanning, signed images, public community instance, **The Nest running in public on Perch**, comparison pages, Hub v1, reliability bar (load, upgrade, chaos tests), accessibility pass, launch week | Public beta: `docker compose up` and `curl \| sh` both work for people who aren't you; time-to-first-agent-PR under 10 minutes; a T3 Code user joins a workspace with `perch runner connect` in under five minutes; first external contributor merged |
| **Later** | — | Perch Link (optional hosted OAuth broker, open source, self-runnable), Helm chart, SAML/SCIM, push and offline PWA, voice notes → bots, bot and connector marketplace, LSP-rich editor, multi-node runners, Slack and Discord bridges (Hermes already speaks both), `native-code` engine | — |

## 9. Risks

| Risk | Mitigation |
|---|---|
| OpenCode API churn (v1.x moves weekly) | Pin versions; adapter isolation; `native-code` escape hatch in Phase 5 |
| Vendor ToS drift on subscriptions | Lanes are swappable; core never depends on Lane B; Lane A always works |
| Scope creep (chat alone is a product) | v1 feature-freeze list per phase; ship the exit criteria, nothing else |
| Resource isolation on one box | Runner limits; documented host sizing; idle-out |
| Prompt injection via chat and web | Untrusted wrappers, tool allow-lists, permission prompts for writes |
| Solo-builder bandwidth | Claude Code builds phases from this doc; Nest agents own tests and docs |
| OAuth callback friction for self-hosters | CIMD by default, token paste always, tunnel profile, per-provider wizard with copyable callback and webhook URLs |
| Token exfiltration or confused deputy | MCP gateway is the only path upstream; grants plus audit; no bearer forwarding; personal connections stay personal |
| Maintainer load after open-sourcing | Plugin-shaped contribution surfaces; RFCs gate big changes; Nest agents run first-pass triage (labels, repro, review); "no" is a complete answer |

## 10. Decisions locked (defaults chosen; change deliberately)

1. Language and runtime = TypeScript end to end on Bun (§4.3, §15). Coding engines v1 = ACP + OpenCode server, not a rewrite.
2. Chat = native, not Matrix or Mattermost.
3. Gateway = in-house AI SDK gateway. Aggregators are endpoints you point it at, not components.
4. Editor = CodeMirror 6. Final.
5. Auth and data = better-auth + Postgres (PGlite in laptop mode). No Supabase, no Redis, no object store in the default deployment.
6. Subscriptions = Lanes B and C only, personal scope; Lane A for anything shared.
7. License = AGPL-3.0 for `apps/*`; MIT for `packages/bot-sdk`, `packages/events`, client SDKs, connector manifests, and bot templates. DCO sign-off, no CLA. Locked before the first external PR.
8. Connections = MCP-first. Registration order: pre-registered → CIMD → DCR → token paste. BYO OAuth app wizard for vendors without CIMD or DCR (GitHub today).
9. Tokens never leave Perch. Engines, bots, and external agents reach connected services only through the MCP gateway or `tools.call`.
10. Telemetry = opt-in only, anonymous, fields published.
11. Preview = proxied iframe of the runner's own ports plus a proxy-injected inspector; agent vision = Playwright MCP inside the runner. No remote-browser screen streaming.
12. Wedge = the agents-as-teammates loop (§5.7). Be #1 there; be good enough and interoperable at chat, editor, bot UX, and dev environments. No feature wars with Mattermost or VS Code.
13. ACP is the engine contract. Bespoke adapters exist only for extras an agent offers beyond ACP (OpenCode) or for runtimes that don't speak it yet (Hermes).
14. Standards pack, not house formats: AGENTS.md, Agent Skills for bot skills, `devcontainer.json` for runner images, MCP in both directions, OpenAPI-first API with generated SDKs.
15. Laptop mode ships before public beta. The single binary is the first-touch story; compose is the team story.
16. Coexist with T3 Code: be the room, not the surface. No feature war for the laptop; the local runner is the bridge, and the comparison page says so.
17. UI/UX reference set = OpenCode (session-first), Slack (navigation and messaging), Cursor (editor and review), Plane (work management). One shell, five regions, one composer, one command palette. Nothing is added that isn't traceable to one of the four or to the wedge.

## 11. Positioning and launch (12birb flavor)

- **Tagline:** *Your code. Your crew. Your bots. Your models. Self-hosted.*
- **Who it's for:** indie devs, small studios, and creator teams running mixed AI stacks who want one room for humans and agents without paying per-seat for chat, an AI editor, and a bot platform separately.
- **Wedge:** OpenCode-simple coding plus a Slack where your agents are teammates.
- **Dogfood first:** 12birb runs on it: Newsroom Grok, the magazine Editor bot, GAM3 TALK show-notes bot, and Nest agents in channels.
- **The build is the content:** stream the build, ship a newsletter series ("we built a Slack where Grok, GPT, and our own agents are coworkers"), cut clips with the video pipeline. Launch = open-source core on GitHub + a one-line install + the series finale.
- **Open source is the story:** "the self-hosted room where your agents and your accounts already live." AGPL core, MIT SDKs, no crippleware, your keys and tokens never leave your box. Every connector and bot template is a contribution someone can make in an afternoon.
- **Later:** Perch Cloud (hosted) and Perch Link (zero-config OAuth broker) for teams that don't want to run Docker or register apps.

## 12. Open source and self-host strategy

**License (decided).** AGPL-3.0 for `apps/*` (api, web, supervisor, runner). MIT for `packages/bot-sdk`, `packages/events`, client SDKs, connector manifests, and bot templates, so anyone can build bots, connectors, and integrations without copyleft questions. Trademark policy: the Perch name and logo are reserved for official builds; forks rename. Why AGPL over Apache-2.0: it keeps a future Perch Cloud viable against hosted resale by larger players; the cost is some enterprise legal friction, which the MIT SDK boundary mostly absorbs. Relicensing later needs every contributor's consent under DCO, so this is locked before the first external PR.

**Contributor terms.** DCO sign-off, no CLA. Lower friction; the tradeoff (no unilateral relicensing) is acceptable because AGPL is the long-term license.

**The pledge.** A signed `PLEDGE.md` in the repo: the core stays under OSI-approved licenses, there will be no branding clause, no CLA that enables relicensing, no feature removed from self-hosted to sell it hosted, and telemetry stays opt-in. The community is scarred by license changes at Redis, HashiCorp, Open WebUI, and n8n; this is free positioning that the projects who already switched cannot copy. Comparison pages (Perch vs Cursor, OpenCode, Open WebUI, Mattermost, Vibe Kanban, OpenHands) state it plainly and stay honest about where each of them is better.

**Repo.** `github.com/12birb/perch`, single monorepo. Day-one files: `LICENSE` (AGPL-3.0) plus per-package `LICENSE` (MIT); `README.md` with a 60-second install, screenshots, and a 90-second demo GIF; `CONTRIBUTING.md`; `CODE_OF_CONDUCT.md` (Contributor Covenant); `SECURITY.md` (private reporting via GitHub Security Advisories, 90-day disclosure); `GOVERNANCE.md` (BDFL now, maintainers added by contribution record); `docs/rfcs/` for big changes; `DECISIONS.md` (ADRs); `docs/policies/providers.md` (the three lanes and vendor ToS); `docs/telemetry.md`; issue and PR templates; `good first issue` and `help wanted` labels; CODEOWNERS.

**Releases.** Semver. `main` protected with required CI. Changesets for versioning and changelog. GitHub Releases with multi-arch images (amd64, arm64) on GHCR, cosign-signed, SBOM attached. Nightly tag. `docker-compose.yml` pinned per release. `perch` CLI: `curl -fsSL https://get.perch.dev | sh` (checksum-verified) or `npx perch@latest init`; `perch doctor` checks Docker version, ports, `PERCH_PUBLIC_URL`, disk, and memory; `perch upgrade` runs migrations with a pre-upgrade backup. Upgrade notes flag breaking changes.

**Deploy targets.** Docker compose is primary; the `perch` binary via `curl | sh`, `npx perch`, Homebrew cask, winget, AUR, and a nix flake. One-click templates: Coolify, Railway, Render, Fly.io. Home-lab templates (Unraid, TrueNAS, CasaOS) community-maintained and linked from docs. Helm chart in Phase 5. ARM64 builds for Raspberry Pi 5 and Apple Silicon. Guides: Caddy public domain, cloudflared tunnel profile, Tailscale Serve and Funnel, running behind Nginx or Traefik, SMTP for email, S3-compatible storage.

**Security posture.** Threat model doc covering multi-user on a shared host, prompt injection, token exfiltration, and confused deputy. Renovate for dependencies; CodeQL, Trivy, and secret scanning in CI; no secrets in images; signed releases; coordinated disclosure; bug bounty once there is money.

**Telemetry and privacy.** None by default. Opt-in anonymous ping (version, OS, arch, user-count bucket) with a visible checkbox in the setup wizard. Never message content, prompts, or tokens. `docs/telemetry.md` lists every field.

**Community.** GitHub Discussions for design. A public dogfood instance where the community lives inside Perch, with the Grok, GPT, and Nest bots present: the product is the demo. Discord bridge via the Hermes gateway for people who won't leave Discord. Monthly changelog post plus community showcase (bots, connectors, themes). 12birb streams the build.

**Sustainability.** GitHub Sponsors and Open Collective from day one. Later: Perch Cloud (hosted) and Perch Link (a hosted OAuth broker that holds official vendor client registrations and hands tokens to an instance encrypted to that instance's key, storing nothing at rest; optional, open source, self-runnable) as the paid convenience layer. Self-hosted core stays complete: no crippleware, no seat limits.

**Contribution surfaces designed to grow.** Connector manifests, bot templates, engine adapters (contract-tested), themes, i18n. All plugin-shaped from Phase 0, each with a template PR and a checklist.

## 13. Kickoff prompt for Claude Code

```
You are building Perch, a self-hosted agentic workspace: IDE + team chat + bots + connections + model
gateway. PERCH-PLAN.md is the spec. Read it fully before writing code. Sections that bind you:
§4.3 (stack), §6 (schema), §15 (build sheet), §16 (contracts), §17 (task order).

Rules of engagement:
- TypeScript end to end on Bun. Bun workspaces + Turborepo, Biome, strict TS, Zod at every boundary.
- Work through §17 in order, one task per PR, each PR with tests and a changeset. Do not start a task
  whose prerequisites are unmerged. Do not skip a Phase 0 spike (§15.6); record each spike's outcome
  in DECISIONS.md before building on it.
- Resolve exact package names and versions from official docs at the start of Phase 0 and pin them.
- Implement the interfaces named in §16 exactly (paths, envelopes, event names). Deviations are ADRs.
- No connection token, API key, or subscription credential ever reaches an engine, a bot, a model
  context, or a log line. No Docker socket in api. Runners only speak the §16.6 protocol.
- Every screen follows §5.0 (shell, composer, tokens); every list is virtualized; every flow works
  on a 390 px viewport.
- Definition of done for a task is in §15.5. A task is not done until `bun run check` (lint, typecheck,
  unit, integration) and the relevant Playwright spec pass in CI.
- Do not ask questions. Choose sane defaults, record them in DECISIONS.md, keep going.

Start with §17 Phase 0, task 0.1.
```

## 14. Category strategy (from PERCH-COMPETITIVE-GAPS.md)

Full analysis, competitor map, ranked gaps, non-goals, and metrics live in `PERCH-COMPETITIVE-GAPS.md`. The P0 list, the items that must land before public beta:

1. Laptop mode: single `perch` binary on PGlite (Phase 1)
2. ACP as the engine contract (Phase 1)
3. Standards pack: AGENTS.md, Agent Skills, `devcontainer.json`, MCP both ways, OpenAPI + SDKs (Phases 1–2)
4. Interactive message blocks (Phase 2)
5. Approval inbox (Phase 2)
6. Policy engine with model allow-lists and secret scanning on agent diffs (Phase 2)
7. Project env and secrets with connector import (Phase 2)
8. Repo intelligence: `@codebase`, semantic search, generated docs, project memory (Phase 2)
9. Parallel agents: worktree per task, board, merge queue, race mode, background sessions (Phase 3)
10. Trust posture: OSI licenses, DCO, `PLEDGE.md`, telemetry off, comparison pages (Phase 0 and 4)
11. Reliability bar: load, upgrade, and chaos tests with published targets (Phase 4)
12. The Nest running in public on Perch, starter stacks, and a launch week (Phase 4)
13. Local runner: `perch runner connect` so any laptop or GPU box joins the room without giving up its subscriptions (Phase 2)
14. `cli-harness` engine for bring-your-own-subscription through official CLIs, personal scope (Phases 1–2)
15. Per-turn diff review (Phase 1) and the Pull Requests page (Phase 3)
16. Package-manager distribution: brew, winget, AUR, nix (Phase 4)

Non-goals that protect the wedge: VS Code parity, Slack parity, federation and E2EE, a vendor subscription broker, a project-management suite, SAML before Phase 5, and a better GUI for one laptop's agents (T3 Code's turf; interoperate instead).

## 15. Build sheet

### 15.1 Repository layout

```
perch/
  apps/
    web/            React 19 + Vite PWA. Routes: /home, /code, /work, /bots, /inbox, /search, /settings
    api/            Bun + Hono. Entrypoints: api (serve), supervisor (docker), worker (jobs only, optional)
    runner/         Bun runner agent: PTY, engines, fs, git, ports, preview tunnel. Same code for hosted and local
    cli/            `perch` binary: dev (laptop mode), runner connect, doctor, backup, restore, migrate, upgrade
  packages/
    db/             Drizzle schema (§6), migrations, shapes (Zod for jsonb), Db factory for postgres and pglite
    events/         Zod schemas for WS envelopes, bus events, runner JSON-RPC, EngineEvent
    api-client/     Generated TypeScript SDK from OpenAPI (+ python/ generated SDK)
    bus/            Bus interface, in-process impl, redis impl (Phase 5)
    jobs/           Postgres queue, cron, retry, worker loop
    vault/          AES-256-GCM envelope encryption, key rotation, Vault interface
    gateway/        AI SDK provider registry, model catalog, /v1 handlers, cost tables
    engines/        Engine interface, adapters: acp, opencode, cli-harness, native, hermes
    connect/        Provider manifests, OAuth flows (CIMD, DCR, pre-registered, token), MCP gateway, GitHub App
    bots/           Bot runtime: triggers, tools, chains, QuickJS sandbox, Bot API handlers
    policy/         policy.yaml parser and evaluator
    preview/        Port discovery, proxy, inspector injection, share links
    inspector/      @perch/inspector build plugins (vite, next, webpack) + injected client script
    bot-sdk/        MIT. TypeScript SDK for code bots and external bots
    ui/             MIT. Tokens, themes, shadcn base, Perch components (§5.0)
  connectors/       MIT. manifest.yaml per provider + connectors.json index
  templates/        MIT. Bot templates, starter stacks, demo workspace seed
  deploy/           docker-compose.yml, Caddyfile, Dockerfile.api, Dockerfile.runner, one-click templates
  docs/             Docs site (Astro Starlight), policies/, telemetry.md, rfcs/
  scripts/          release, sbom, perf-audit, seed
  DECISIONS.md  PLEDGE.md  SECURITY.md  GOVERNANCE.md  CONTRIBUTING.md  LICENSE (AGPL-3.0)
```

### 15.2 Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PERCH_PUBLIC_URL` | required in team mode | Canonical HTTPS origin; callbacks, webhooks, CIMD, deep links |
| `PERCH_PREVIEW_DOMAIN` | unset → path mode | Wildcard domain for `https://<port>--<workspace>.<domain>` |
| `PERCH_MASTER_KEY` | generated on first run in laptop mode; required in team mode | 32-byte base64 root key for the vault |
| `DATABASE_URL` | `pglite://~/.perch/data` in laptop mode | Postgres connection string in team mode |
| `PERCH_RUNNER_MODE` | `docker` | `docker` (supervisor per workspace), `shared`, or `inprocess` (laptop) |
| `PERCH_RUNNER_IMAGE` | `ghcr.io/12birb/perch-runner:<version>` | Runner image the supervisor launches |
| `PERCH_RUNNER_LIMITS` | `cpus=2,memory=4g,pids=512` | Per-runner container limits |
| `PERCH_RUNNER_IDLE_MINUTES` | `30` | Idle timeout before a hosted runner is stopped |
| `PERCH_FILES_DIR` | `/data/files` | Local file store |
| `PERCH_S3_ENDPOINT`, `PERCH_S3_BUCKET`, `PERCH_S3_KEY`, `PERCH_S3_SECRET`, `PERCH_S3_REGION` | unset | S3-compatible file store; set all five to enable |
| `PERCH_SMTP_URL` | unset | Email for invites and password reset; console transport when unset |
| `PERCH_TELEMETRY` | `off` | `on` sends the anonymous ping described in docs/telemetry.md |
| `PERCH_OTLP_ENDPOINT` | unset | OpenTelemetry export |
| `PERCH_LOG_LEVEL` | `info` | pino level |
| `PERCH_SESSION_SECRET` | derived from master key | better-auth secret |
| `PERCH_OIDC_ISSUER`, `PERCH_OIDC_CLIENT_ID`, `PERCH_OIDC_CLIENT_SECRET` | unset | Optional SSO |
| `PERCH_ALLOW_LOOPBACK_REDIRECTS` | `true` in laptop mode, `false` in team mode | OAuth loopback redirects |
| `PERCH_DEFAULT_LOCALE` | `en` | i18n |
| `PERCH_DEMO_WORKSPACE` | `true` on first run | Seed the demo workspace |
| `DOCKER_HOST` | `unix:///var/run/docker.sock` (supervisor only) | Docker socket |
| `CADDY_DNS_PROVIDER`, `CADDY_DNS_TOKEN` | unset | DNS challenge for the preview wildcard |

### 15.3 Compose, Caddy, images

`deploy/docker-compose.yml` (abridged; the real file is generated by `perch init` with pinned tags):

```yaml
services:
  caddy:
    image: ghcr.io/12birb/perch-caddy:${PERCH_VERSION}     # caddy + dns provider modules
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile", "caddy_data:/data"]
    environment: [PERCH_PUBLIC_URL, PERCH_PREVIEW_DOMAIN, CADDY_DNS_PROVIDER, CADDY_DNS_TOKEN]
  api:
    image: ghcr.io/12birb/perch-api:${PERCH_VERSION}
    env_file: .env
    depends_on: { postgres: { condition: service_healthy } }
    volumes: ["files:/data/files"]
    healthcheck: { test: ["CMD", "bun", "run", "healthcheck"], interval: 10s }
  supervisor:
    image: ghcr.io/12birb/perch-api:${PERCH_VERSION}
    command: ["supervisor"]
    env_file: .env
    volumes: ["/var/run/docker.sock:/var/run/docker.sock", "runner_homes:/data/homes", "projects:/data/projects"]
  postgres:
    image: pgvector/pgvector:pg16
    environment: [POSTGRES_DB=perch, POSTGRES_USER=perch, POSTGRES_PASSWORD]
    volumes: ["pg:/var/lib/postgresql/data"]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U perch"], interval: 5s }
  ollama:
    image: ollama/ollama
    profiles: ["local"]
    volumes: ["ollama:/root/.ollama"]
  cloudflared:
    image: cloudflare/cloudflared
    profiles: ["tunnel"]
    command: ["tunnel", "run"]
    environment: [TUNNEL_TOKEN]
volumes: { caddy_data: {}, files: {}, pg: {}, runner_homes: {}, projects: {}, ollama: {} }
```

Caddyfile: `{$PERCH_PUBLIC_URL}` → `reverse_proxy api:3000` with WebSocket passthrough; `*.{$PERCH_PREVIEW_DOMAIN}` → the same upstream with `tls { dns {$CADDY_DNS_PROVIDER} {$CADDY_DNS_TOKEN} }`. Runners are never exposed through Caddy; the api reaches hosted runners over the compose network and local runners over their outbound connection.

Images: `Dockerfile.api` (oven/bun base, `bun install --frozen-lockfile`, `bun build` of web, non-root user, `bun run start`); `Dockerfile.runner` (Ubuntu 24.04, Bun, Node LTS, Python + uv, git, ripgrep, the pinned OpenCode binary, Hermes Agent, Claude Code, Codex CLI, Gemini CLI, Playwright Chromium, tmux; the runner agent as the entrypoint; per-user home volumes at `/data/homes/<user>`). Both multi-arch, cosign-signed, with SBOMs.

### 15.4 CI and release

GitHub Actions on every PR: `bun install --frozen-lockfile` → Biome → typecheck → `bun test` (with PGlite) → Playwright (compose smoke on Linux, laptop-mode smoke on Linux, macOS, Windows) → axe accessibility → perf audit script (WS payload budget, bundle size budget) → Trivy on images → CodeQL weekly. On a version tag: build multi-arch images, cosign sign, attach SBOM, publish `perch` binaries and the `npx perch` package, generate SDKs from the OpenAPI document, publish the docs site. Changesets produce the changelog; Renovate opens weekly dependency PRs.

### 15.5 Conventions and definition of done

- **Layers:** route handler (Hono + Zod) → service (pure functions over `Db` and `Bus`) → repository (Drizzle). No SQL in handlers, no HTTP in services.
- **Errors:** typed `PerchError(code, message, details, status)`; the wire shape is §16.9; never leak stack traces or secrets.
- **Authz:** every handler calls `authorize(ctx, action, resource)` from `packages/policy`; workspace scoping is enforced in repositories, never trusted from the client.
- **Events:** every state change emits a bus event from `packages/events`; WS fan-out, inbox, webhooks, and audit subscribe to the bus. No feature writes to the audit log directly.
- **Migrations:** `drizzle-kit generate`, committed, run on boot with an advisory lock; never edit a shipped migration.
- **Logging:** pino, one line per request with `request_id`, `workspace_id`, `user_id`; secrets redacted by key list.
- **Feature flags:** `instance_settings.flags` read through `flags.isOn(name)`; flags default off and die within two releases.
- **i18n:** every user-facing string through `t("key")` from day one, even with only `en`.
- **Accessibility:** roles and labels on every component; keyboard path tested in Playwright for each screen.
- **Commits and PRs:** conventional commits, DCO sign-off, one task per PR, PR template with test plan and screenshots for UI.
- **Definition of done:** code + tests + changeset + docs page updated + DECISIONS.md entry for any choice not in this plan + `bun run check` green + the task's acceptance criterion demonstrated in the PR description (a Playwright spec or a recorded command).

### 15.6 Phase 0 verifications (spikes)

Each spike is a task with a pass/fail criterion and a recorded fallback. Outcomes go in `DECISIONS.md`.

| Spike | Pass criterion | Fallback if it fails |
|---|---|---|
| PTY on Bun | `node-pty` opens a shell, resizes, and survives 1,000 writes on linux x64/arm64, macOS, Windows | `bun-pty` on the failing platform; document it |
| ACP handshake | The ACP SDK client initializes Gemini CLI and Codex, streams a session, and answers a permission request | Pin the last working SDK version; open an upstream issue |
| OpenCode SDK | `opencode serve` + SDK: create session, send prompt, stream events, apply a diff, list sessions | Drive OpenCode through ACP only |
| PGlite | vector extension + tsvector + SKIP LOCKED queries pass the `packages/db` test suite in memory | Laptop mode ships with embedded Postgres via `embedded-postgres` |
| QuickJS sandbox | A code bot runs with a 200 ms CPU budget, no host access, and a tool call round trip | Run all code bots in runner containers |
| better-auth on Bun | Email + password, passkeys, and generic OIDC flows pass Playwright | Pin version; patch adapter |
| dockerode from Bun | Supervisor creates, limits, execs into, and removes a runner container | Supervisor runs on Node LTS in its own image |
| Caddy wildcard | DNS-challenge wildcard cert issues for `*.preview.example.test` in CI | Path-mode previews only until fixed |
| Preview tunnel over a local runner | HMR WebSocket for a Vite app on a local runner works end to end through the api | Local previews open directly on localhost with a "local only" badge |
| cloudflared profile | Callback and webhook reach the api through the tunnel | Document Tailscale as the recommended alternative |

## 16. API and protocol contracts

All HTTP under `/api` is versioned by header (`Perch-Version: 2026-09-01`); the OpenAPI document at `/api/openapi.json` is the source of truth and generates the SDKs. Authentication: session cookie (web), `Authorization: Bearer <api_token>` (SDKs, MCP server), `Authorization: Bearer pk_...` (virtual keys on `/v1` and `/mcp`), `Authorization: Bearer xoxb_...`-style bot tokens on the Bot API.

### 16.1 REST resources (OpenAPI)

| Resource | Endpoints |
|---|---|
| Auth and users | better-auth routes under `/api/auth/*`; `GET /api/me`; `PATCH /api/me`; `GET/POST/DELETE /api/me/tokens` |
| Workspaces | `GET/POST /api/workspaces`; `GET/PATCH /api/workspaces/{ws}`; `GET/POST/PATCH/DELETE .../members`; `POST .../invites`; `POST /api/invites/{token}/accept` |
| Projects | `GET/POST /api/workspaces/{ws}/projects`; `GET/PATCH/DELETE .../projects/{p}`; `POST .../projects/{p}/clone`; `GET/PUT .../projects/{p}/env`; `GET/PUT .../projects/{p}/config` |
| Runners | `GET .../runners`; `POST .../runners/tokens` (mint a connect token); `DELETE .../runners/{r}`; `GET .../runners/{r}/ports` |
| Files | `POST /api/workspaces/{ws}/files` (multipart); `GET /api/files/{id}`; `GET /api/files/{id}/preview` |
| Channels and messages | `GET/POST .../channels`; `GET/PATCH .../channels/{c}`; `POST .../channels/{c}/members`; `GET .../channels/{c}/messages?before&after&limit`; `POST .../channels/{c}/messages`; `PATCH/DELETE /api/messages/{m}`; `POST/DELETE /api/messages/{m}/reactions`; `GET /api/messages/{m}/thread`; `GET/PUT /api/threads/{root}/facts` |
| Search | `GET /api/workspaces/{ws}/search?q&type=messages,code,items,sessions` |
| Bots | `GET/POST .../bots`; `GET/PATCH/DELETE .../bots/{b}`; `POST .../bots/{b}/install`; `POST .../bots/{b}/test`; `GET .../bots/{b}/runs`; `POST .../bots/{b}/tokens` |
| Brains | `GET/POST/DELETE .../credentials`; `GET/POST/PATCH/DELETE .../model-profiles`; `GET .../models` (catalog); `GET/POST/DELETE .../virtual-keys`; `GET .../usage?from&to&group_by` |
| Sessions | `POST .../projects/{p}/sessions`; `GET/DELETE /api/sessions/{s}`; `POST /api/sessions/{s}/turns`; `POST /api/sessions/{s}/permissions/{id}`; `POST /api/sessions/{s}/cancel`; `GET /api/sessions/{s}/events?after_seq`; `GET /api/sessions/{s}/diff?turn`; `POST /api/sessions/{s}/diff/apply` (hunk decisions); `POST /api/sessions/{s}/checkpoints/{turn}/restore`; `POST /api/sessions/{s}/share` |
| Connections | `GET .../connections`; `POST .../connections/start` (returns authorize URL or token form); `GET /connect/callback/{provider}`; `DELETE .../connections/{id}`; `POST .../connections/{id}/test`; `GET/POST/DELETE .../connections/{id}/grants`; `GET/POST/DELETE .../oauth-clients`; `GET/POST/DELETE .../mcp-servers`; `GET /.well-known/oauth-client-metadata.json` |
| Preview | `GET .../projects/{p}/previews`; `POST .../previews/{port}/share`; `DELETE /api/preview-shares/{id}`; `GET /p/{ws}/{port}/*` (path mode) |
| Work | `GET/POST .../projects/{p}/work-items?view`; `GET/PATCH/DELETE /api/work-items/{id}`; `POST /api/work-items/{id}/start-session`; `GET/POST .../projects/{p}/cycles`; `.../modules`; `GET/POST .../views`; `GET .../projects/{p}/intake`; `POST /api/work-items/{id}/intake/{accept,decline}` |
| Inbox | `GET /api/inbox?status`; `POST /api/inbox/{id}/{resolve,snooze}` |
| Policies | `GET/PUT .../policy`; `GET/PUT .../projects/{p}/policy`; `POST .../policy/evaluate` (dry run) |
| Webhooks | `GET/POST/DELETE .../webhooks/inbound`; `POST /hooks/{provider}/{id}` (public, signature-verified); `GET/POST/DELETE .../webhooks/outbound` |
| Admin | `GET/PUT /api/admin/settings`; `GET /api/admin/audit?from&to`; `POST /api/admin/backup`; `GET /api/health`; `GET /api/version` |

### 16.2 WebSocket client protocol (`/api/ws`)

One socket per tab. Client → server: `{ "op": "subscribe", "topics": ["ws:<id>", "channel:<id>", "session:<id>", "inbox:<user>"] }`, `unsubscribe`, `ping`, `typing`, `presence`. Server → client envelope: `{ "type": "<event>", "topic": "...", "seq": 1234, "ts": "...", "payload": {...} }`. Every event carries a per-topic `seq`; on reconnect the client sends `{ "op": "resume", "topic": ..., "after_seq": n }` and the server replays from the bus buffer (last 1,000 per topic) or tells it to refetch. Streaming session output uses `session.delta` events batched per animation frame on the client.

### 16.3 Bot API (Slack-shaped)

`POST /api/bot/chat.postMessage` `{ channel, text | blocks, thread_ts? }` → `{ ok, message_id, ts }`; `POST /api/bot/chat.update`; `POST /api/bot/chat.delete`; `GET /api/bot/conversations.list`; `GET /api/bot/conversations.history?channel&oldest&latest&limit`; `GET /api/bot/conversations.replies?ts`; `GET /api/bot/users.info?user`; `POST /api/bot/files.upload`; `POST /api/bot/tools.call` `{ connection_id, tool, args }` (§16.5 semantics); `POST /api/bot/work.create`; `POST /api/bot/sessions.open`. Events over `wss:///api/bot/socket` (socket mode) or a webhook URL with HMAC signature: `message.created`, `app_mention` (with `mentioned_by`, `mode`, `root_id`, `hop`, `budget_remaining`), `reaction.added`, `channel.joined`, `interaction.received`, `session.completed`, `work_item.updated`. Scopes: `chat:write`, `chat:read`, `channels:read`, `files:write`, `tools:call`, `sessions:open`, `work:write`. Rate limit: 60 requests per minute per bot by default, `Retry-After` on 429.

### 16.4 Model gateway (`/v1`)

OpenAI-compatible `POST /v1/chat/completions` (streaming and non-streaming), `GET /v1/models`, `POST /v1/embeddings`. Auth: `Authorization: Bearer pk_...` (virtual key). The `model` field is a model profile name or `provider/model_id` on the workspace allow-list. Response headers: `Perch-Cost-Usd`, `Perch-Input-Tokens`, `Perch-Output-Tokens`, `Perch-Budget-Remaining`. Budget exhaustion returns 402 with `budget_exceeded`. Fallback chains from the profile apply transparently; the chosen provider is reported in `Perch-Provider`.

### 16.5 MCP gateway (`/mcp/{connectionId}`)

Streamable HTTP MCP server per connection (and per runner-local server). Auth: Perch session, api token, or virtual key with a grant. Tools are filtered by the grant's `allowed_tools`; a tool marked `requires_permission` in policy returns `pending` with an `inbox_item` id, the caller polls or waits on the WS topic, and the call completes when the human approves. Every call is audited with the caller, connection, tool, args hash, and outcome. The upstream request carries the connection's delegated token and never the caller's bearer. Perch's own MCP server lives at `/mcp/perch` with tools `channels.list`, `messages.search`, `messages.post`, `work.create`, `work.update`, `sessions.open`, `connections.call` (grant-checked).

### 16.6 Runner protocol (`wss:///api/runner`)

JSON-RPC 2.0 over one control WebSocket opened by the runner with a connect token; data streams open as additional sockets at `/api/runner/stream/{stream_token}` when the api requests them. Control methods (runner → api): `runner.register { name, kind, capabilities, versions }`, `runner.heartbeat { load, sessions }`, `ports.changed { ports }`, `session.event { session_id, event }`, `pty.data`, `pty.exit`, `fs.changed`. Methods (api → runner): `session.create { project, engine, model, mode, worktree, env }`, `session.send { session_id, turn }`, `session.permission { session_id, permission_id, answer }`, `session.cancel`, `session.checkpoint`, `session.restore`, `pty.open { cols, rows, cwd, user }` → stream token, `pty.input`, `pty.resize`, `pty.close`, `fs.list`, `fs.read`, `fs.write`, `fs.stat`, `fs.search { query, glob }`, `git.status`, `git.diff`, `git.commit`, `git.push`, `git.branch`, `worktree.create`, `worktree.remove`, `ports.list`, `http.open { port, path, method, headers }` → stream token (the preview tunnel; the stream carries the request body, then the response head and body; WebSocket upgrades are tunneled the same way), `mcp.spawn { command, args }` → stream token, `exec { command, cwd, timeout }` (policy-checked). Every request carries `workspace_id`, `user_id`, and a per-request capability token so a runner can verify what the api is allowed to ask; a local runner refuses requests for users other than its owner unless a grant is attached.

### 16.7 Engine interface

As in §4.4. Adapters translate to `EngineEvent`; the api persists every event to `session_events` with a monotonic `seq` and republishes on `session:<id>`. Permission events create `inbox_items`; `usage` events create `usage_events`; `done` triggers preflight if the project policy says so.

### 16.8 Bus event catalog

`workspace.updated`, `member.added|removed|role_changed`, `project.created|updated|deleted`, `runner.registered|online|offline`, `channel.created|updated|archived`, `message.created|updated|deleted`, `reaction.added|removed`, `thread.facts_updated`, `read_state.updated`, `presence.changed`, `typing`, `bot.installed|uninstalled`, `bot.run_started|run_finished|run_failed`, `bot.chain_hop|chain_breaker`, `session.created|delta|tool_call|tool_result|permission_requested|permission_answered|usage|done|error`, `diff.applied`, `checkpoint.created|restored`, `connection.created|refreshed|revoked|failed`, `connection.grant_added|removed`, `tools.called`, `preview.port_detected|share_created|share_revoked`, `work_item.created|updated|state_changed|assigned`, `intake.received|accepted|declined`, `inbox.item_created|resolved`, `policy.violation`, `usage.recorded`, `budget.warning|exceeded`, `webhook.received|delivered|failed`, `audit.logged`.

### 16.9 Error model and identifiers

Errors: `{ "error": { "code": "not_found" | "forbidden" | "validation" | "conflict" | "rate_limited" | "budget_exceeded" | "policy_violation" | "upstream_failed" | "internal", "message": "...", "details": {...} }, "request_id": "..." }` with the matching HTTP status (404, 403, 422, 409, 429, 402, 451, 502, 500). Identifiers: uuid v7 everywhere; work items are `KEY-123` per project; deep links `perch://ws/<slug>/{channel|session|item|pr|preview}/<id>` resolve in the web app and unfurl when pasted.

## 17. Build order: Phases 0–2

One line per task; the acceptance criterion in parentheses is what the PR must demonstrate. Tasks within a phase are ordered by dependency; tasks marked ∥ can run in parallel with their neighbors.

### Phase 0 — Foundation (weeks 1–2)

- 0.1 Repo scaffold: Bun workspaces, Turborepo, Biome, strict TS, Changesets, Renovate, PR and issue templates, LICENSE (AGPL-3.0) + MIT licenses in `bot-sdk`, `ui`, `connectors`, `templates` (CI green on an empty monorepo)
- 0.2 Governance files: README skeleton, CONTRIBUTING with DCO, CODE_OF_CONDUCT, SECURITY.md, GOVERNANCE.md, PLEDGE.md, DECISIONS.md, docs/policies/providers.md, docs/telemetry.md (all present; DCO check enforced)
- 0.3 Dependency resolution: exact package names and versions for §4.3 from official docs, pinned; DECISIONS entry per non-obvious pick (lockfile committed)
- 0.4 Spikes from §15.6, one PR each, outcomes in DECISIONS.md ∥ (every spike has a recorded pass or fallback)
- 0.5 `packages/db`: Drizzle schema for the identity, tenancy, projects, runners, channels, messages, files, and instance_settings groups of §6; `Db` factory for postgres and pglite; migrations; PGlite test harness (schema tests pass on both drivers)
- 0.6 `packages/events`, `packages/bus`, `packages/jobs`, `packages/vault` with unit tests (queue survives worker crash, cron fires, vault round-trips and rotates)
- 0.7 `apps/api` skeleton: Hono + zod-openapi, error model, request logging, health, version, OpenAPI at `/api/openapi.json`, generated TS client (`GET /api/health` typed end to end)
- 0.8 Auth: better-auth with Drizzle adapter, email + password, passkeys, generic OIDC, `users` profile row, invites, `api_tokens` (Playwright: sign up, sign in with passkey, invite accepted)
- 0.9 Workspaces, memberships, RBAC, `authorize()` middleware, audit log via bus (member cannot read another workspace; audit rows appear)
- 0.10 WS server: subscribe, resume with seq, presence, typing (Playwright: two tabs see each other's presence; reconnect replays)
- 0.11 `packages/ui`: tokens, dark and light themes, shadcn base, Shell, Rail, Sidebar, Panel, Drawer, CommandPalette, Peek, Composer skeleton (Storybook-free component tests with Playwright CT; axe passes)
- 0.12 `apps/web` shell: routes for the six rail tabs, mobile tab bar, empty states, settings pages for profile and workspace (390 px and 1440 px screenshots in the PR)
- 0.13 Deploy: `Dockerfile.api`, `Dockerfile.runner` base, compose, Caddyfile, `perch init` writes `.env` and compose with pinned tags, setup wizard (first-run: admin, workspace, `PERCH_PUBLIC_URL`, telemetry checkbox) (fresh Ubuntu VM: `docker compose up` → wizard → sign in)
- 0.14 `apps/cli` skeleton: `perch dev` on PGlite with in-process runner stub, `perch doctor`, `perch backup|restore` (laptop smoke test in CI on Linux, macOS, Windows)
- 0.15 CI pipeline from §15.4 including multi-arch image publish on tag and cosign (a tagged pre-release publishes signed images)

### Phase 1 — IDE core (weeks 3–6)

- 1.1 `apps/runner` control channel: register, heartbeat, capability token verification, hosted mode inside the runner image (supervisor launches a runner that registers within 5 s)
- 1.2 Supervisor: dockerode lifecycle, limits, idle stop, per-user home volumes, `PERCH_RUNNER_MODE=shared` (two workspaces get two containers; idle stop after the timeout)
- 1.3 Local runner: `perch runner connect <workspace>` with a minted token, owner-only access, Environments page (a laptop registers and shows online from a phone)
- 1.4 Projects: create empty, upload, clone via HTTPS token or SSH deploy key; project volume; `.perch/project.json` read and validated; `devcontainer.json` honored for the runner image (clone a public repo; config defaults applied)
- 1.5 Runner fs, git, ports, exec methods with policy hooks (fs.search under 200 ms on a 50k-file repo)
- 1.6 Code mode: file tree, EditorGroup with CodeMirror 6, tabs, breadcrumbs, search/replace, markdown and image preview (open, edit, save, reopen)
- 1.7 Terminal: `pty.open` streams, xterm.js drawer, tmux persistence, per-user shells, path links open in the editor (reload keeps the shell)
- 1.8 `packages/engines`: Engine interface, EngineEvent persistence, session lifecycle, `session_events` replay endpoint (unit tests with a fake engine)
- 1.9 ACP adapter: spawn registry agents, map events, permissions, modes, MCP passthrough for Perch tools (Gemini CLI and Codex complete a two-turn session with one permission prompt)
- 1.10 OpenCode adapter: `opencode serve` per project, SDK client, plan/build, subagents (a session edits a file and the diff arrives as EngineEvents)
- 1.11 `cli-harness` adapter behind a feature flag: Codex `exec --json` and Claude Code `-p --output-format stream-json` (flag off; both work in a local runner under the owner's login)
- 1.12 Session pane: Composer in session mode, streaming transcript, tool cards, PermissionPrompt, usage footer, session list, fork, rename (Playwright: plan → build → permission → done)
- 1.13 DiffView: per-turn and cumulative diffs, hunk accept/reject, Accept all / Reject all, Restore checkpoint, Apply on code blocks (accept two hunks, reject one, restore turn 1)
- 1.14 ⌘K inline edit in the editor (select, instruct, diff in place, accept)
- 1.15 Brains v1: credentials vault UI, model profiles, catalog seeded from models.dev, endpoint providers including Ollama auto-detect, model picker in the composer (an OpenAI key and an Ollama endpoint both run a session)
- 1.16 Connections v1: `packages/connect` core, provider manifest schema, token paste, OAuth callback route, CIMD document, GitHub App wizard and connector (installation tokens, repo list, clone, push, open PR) (clone via GitHub connection → PR opened)
- 1.17 MCP gateway skeleton: `/mcp/{connectionId}` proxy with token injection, allow-lists, audit; GitHub's MCP through a PAT connection exposed to an ACP session (agent lists issues through the gateway; PAT never appears in the runner)
- 1.18 Preview v1: port discovery, path-mode proxy, wildcard mode behind Caddy, WebSocket passthrough, Preview tab with URL bar, viewport presets, reload, open in new tab, `preview` block in project config, share links (Vite HMR works through both modes; a share link opens without the inspector)
- 1.19 Preview tunnel over local runners via `http.open` (HMR through a laptop runner from a phone)
- 1.20 Git panel: status, stage, commit with AI message, branch, push, Open PR (commit and PR from the panel)
- 1.21 Laptop mode parity: `perch dev` runs 1.4–1.20 in-process on PGlite (laptop smoke test extended to a full session)
- 1.22 Phase 1 e2e: the roadmap exit criterion as one Playwright spec, run on a paid key, on Ollama, through OpenCode, and through ACP (four green runs in CI)

### Phase 2 — Chat, bots, the loop's front half (weeks 7–10)

- 2.1 Channels: public, private, DMs, groups, item threads; membership; header; archive; sidebar sections with unread weight (Playwright: create, join, leave, archive)
- 2.2 Messages: blocks, edit history, delete, threads with reply counts, hover toolbar, pins, bookmarks (Later), read state and unread badges, mentions with autocomplete for people, bots, groups, channels, work items, files (Playwright covers each)
- 2.3 Reactions, files with previews, link unfurls for Perch identifiers, web push (push arrives on a phone for a mention)
- 2.4 Search: Postgres full-text over messages and files with filters; results page with peek (query returns in under 150 ms on 100k messages)
- 2.5 Interactive blocks: BlockRenderer for button, select, form, approve_deny, progress; `interaction.received` delivery; in-place update (a bot's approve button updates the message and the bot receives the payload)
- 2.6 Native bot runtime: triggers (dm, mention, keyword, schedule, webhook, reaction), tool registry (`web_search`, `http_fetch`, `chat_post`, `chat_read`, `remember`, `recall`, `thread_facts`), streaming replies with placeholder edit, budgets, rate limits (a template bot answers a mention within budget)
- 2.7 Bot-to-bot mentions: `mention`, `wait_for_replies`, `hand_off`, chain tracking, hop limit, repeat-pair breaker, per-thread budget, ChainHeader, intervene card (three bots complete a fan-out; a ping-pong pair trips the breaker)
- 2.8 Forge UI level 1: form, live test chat, publish to channels, templates Grok Newsroom, GPT Helpdesk, Claude Reviewer, Local Llama, 12birb Editor, GAM3 TALK Show Notes; bot `skills/` in the Agent Skills format (create Grok Newsroom from the template; `@grok` answers in `#general`)
- 2.9 DM-a-bot with model picker and "New chat" threads (fresh context per thread)
- 2.10 Inbox: `inbox_items` from permissions, chains, budgets, mentions; InboxList, resolve, snooze, batch approve; mobile launch tab (approve a session permission from the inbox on a phone)
- 2.11 Policy engine v1: `policy.yaml` schema, evaluator, protected branches, denied commands, path lists, model allow-lists per channel and project, budget ceilings, violation cards, dry-run endpoint (a channel pinned to local models refuses a cloud profile; `git push --force` is blocked)
- 2.12 Secret scanning on agent diffs before commit (a planted key blocks the commit with a card)
- 2.13 Project env and secrets: encrypted env, injection into runner, sessions, and previews; import from connectors once they exist (a session sees `DATABASE_URL`; it never appears in a transcript)
- 2.14 Connections v2: MCP OAuth with CIMD, DCR, pre-registered; BYO OAuth wizard; Vercel, Supabase, Clerk connectors; connection test; grants UI; on-behalf-of rule (Supabase MCP connects via DCR; a shared bot is refused a personal connection)
- 2.15 Deploy button and DB panel: Vercel deploy from the IDE with preview URL card; Supabase schema browser in the panel, read-only by default (deploy posts its preview URL in a thread)
- 2.16 Inspector v1: `@perch/inspector` plugins (Vite, Next, Webpack), injected client, Elements tree, select → context chip, console and failed requests strip with "Send to agent", screenshot to thread via Playwright in the runner (click a button → "make this primary" lands the right edit)
- 2.17 Repo intelligence v1: `repo_index` chunking and embeddings on a job, `@codebase` context, semantic search across code and chat, AGENTS.md draft generator (an `@codebase` question cites the right file)
- 2.18 Custom actions, reasoning level, background and auto-settle policies per project (a custom action runs from the session pane and from ⌘K)
- 2.19 Bot API v1: endpoints and socket mode from §16.3 with scopes and rate limits; `bot-sdk` published (an external script posts a message and receives an `app_mention`)
- 2.20 Perf audit script in CI: WS payload budget, bundle size budget, list virtualization check (budgets enforced)
- 2.21 Phase 2 e2e: the roadmap exit criterion as Playwright specs; a11y sweep with axe on Home, Code, Inbox (all green)

Phases 3 and 4 stay at roadmap resolution (§8) until Phase 2 ships; their task lists are written then, from what Phases 0–2 taught.
