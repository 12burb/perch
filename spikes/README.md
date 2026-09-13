# Phase 0 spikes

Spec §9.3: ten verifications, each with a pass criterion and a recorded fallback. They stay runnable here so
the outcome can be re-checked on every platform and every dependency bump; `DECISIONS.md` ADR-0029 to
ADR-0038 record what happened.

| # | Spike | Run | Outcome (Bun 1.3.11, linux x64, 2026-09-13) |
|---|---|---|---|
| 0.4.1 | [PTY on Bun](pty/) | `bun test spikes/pty` | **fallback taken**: node-pty breaks on Bun (`resize` → `ioctl EBADF`, writes → EBADF); **bun-pty passes** the whole scenario. Other platforms: CI `spikes.yml` matrix |
| 0.4.2 | [ACP handshake](acp/) | `bun test spikes/acp` | **pass** with the SDK on both sides (stub agent): initialize, session, streamed text and tool calls, permission answered, `end_turn`. Real Gemini CLI / Codex: `PERCH_SPIKE_ACP_AGENT` (needs vendor keys) |
| 0.4.3 | [OpenCode SDK](opencode/) | `bun test spikes/opencode` | **pass** for serve, session create/list/diff/delete, SSE events, and a credential-less prompt failing cleanly; a real streamed reply needs `OPENAI_API_KEY` or `PERCH_SPIKE_OPENCODE_MODEL` |
| 0.4.4 | [PGlite](pglite/) | `bun test spikes/pglite` | **pass**: pgvector (`@electric-sql/pglite-pgvector`) with HNSW, generated tsvector + GIN, citext, `FOR UPDATE SKIP LOCKED`, advisory locks, all in memory |
| 0.4.5 | [QuickJS sandbox](quickjs/) | `bun test spikes/quickjs` | **pass**: 200 ms CPU budget interrupts, no host globals, async tool round trip, memory limit. The asyncify build is not used on Bun |
| 0.4.6 | [better-auth on Bun](better-auth/) | `bun test spikes/better-auth` | **pass** at the HTTP level with the Drizzle adapter on PGlite: email+password, passkey registration options, generic OIDC (discovery → PKCE → callback → session). Browser passkey ceremony: task 0.8 Playwright |
| 0.4.7 | [dockerode from Bun](dockerode/) | `bun test spikes/dockerode` | **deferred to CI**: no Docker daemon in the build environment; `spikes.yml` runs it on the ubuntu runner |
| 0.4.8 | [Caddy wildcard](caddy-wildcard/) | `bun spikes/caddy-wildcard/check.ts` | **deferred**: needs a real domain and DNS token (`spikes.yml` job gated on `CADDY_DNS_TOKEN`); previews run in path mode until `PERCH_PREVIEW_DOMAIN` is set, which is the spec's fallback and the default |
| 0.4.9 | [Preview tunnel](preview-tunnel/) | `bun test spikes/preview-tunnel` | **pass**: Vite HMR end to end through the api over the runner's outbound socket (HTTP + `vite-hmr` WebSocket, live update after an edit) |
| 0.4.10 | [cloudflared profile](cloudflared/) | `bun spikes/cloudflared/check.ts` | **deferred**: needs a tunnel token (`spikes.yml` job gated on `TUNNEL_TOKEN`); Tailscale Serve/Funnel documented as the alternative |

Every spike is a workspace (`@perch/spike-*`) so its dependencies are pinned in the root lockfile. Tests that
need something the environment lacks skip with a named reason rather than fail.
