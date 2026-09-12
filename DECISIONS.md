# DECISIONS

Architecture decision records for Perch. ADR-0001 to ADR-0017 are the decisions locked by the specification
(`docs/spec/PERCH-SPEC.md`, `docs/spec/PERCH-PLAN.md` §10). Everything after that is a choice the spec did
not make, a spike outcome, or a spec deviation. Change a locked decision only through an RFC
(`GOVERNANCE.md`).

Status values: `accepted`, `superseded by ADR-nnnn`, `deprecated`. Spike outcomes carry `pass`, `partial`,
`deferred`, or `fallback`.

---

## Template

```
## ADR-nnnn: <title>

- Status: accepted | superseded by ADR-nnnn | deprecated
- Date: YYYY-MM-DD
- Task: <TASKS.md id, if any>

### Context
<why a decision was needed, in two or three sentences>

### Decision
<what was decided, precisely enough to implement>

### Consequences
<what follows: constraints, follow-ups, what becomes easier or harder>
```

---

## ADR-0001: TypeScript end to end on Bun; ACP + OpenCode as the coding engines

- Status: accepted
- Date: 2026-09-12
- Task: spec §1, §2, §3.3

### Context
Perch spans web, api, supervisor, runner, CLI, and a single binary. The ecosystem it stands on (AI SDK, MCP
SDK, ACP SDK, OpenCode SDK, Drizzle, PGlite, better-auth, CodeMirror, xterm) is TypeScript-first.

### Decision
One language (TypeScript, strict, `noUncheckedIndexedAccess`, Zod at every boundary) and one runtime (Bun) for
every app and package. Bun workspaces + Turborepo, Biome, Changesets, Renovate. Coding engines in v1 are the
ACP client and the OpenCode server adapter; no agentic loop is rewritten. Python exists only as third-party
agent runtimes inside the runner image. No Go, no Rust.

### Consequences
`bun build --compile` produces the laptop binary. Node-only tooling (Playwright's runner, drizzle-kit) may run
under Node in CI, but no shipped code targets Node. Anything that does not run on Bun (isolated-vm) is out.

## ADR-0002: Chat is native, not Matrix or Mattermost

- Status: accepted
- Date: 2026-09-12
- Task: spec §5.2

### Context
A message is the one primitive shared by channels, DMs, threads, bot runs, and coding sessions; interactive
blocks, bot chains, and session cards need control over the message model.

### Decision
Perch implements its own Slack-shaped chat on Postgres (`channels`, `messages` with jsonb blocks, threads,
reactions, read state, presence, search). No federation, no Matrix homeserver, no embedded Mattermost.

### Consequences
Full control over blocks and bot semantics; bridges to Slack and Discord arrive later through the Hermes
gateway rather than protocol federation.

## ADR-0003: In-house AI SDK gateway; aggregators are endpoints, not components

- Status: accepted
- Date: 2026-09-12
- Task: spec §3.4

### Context
Bots, `/v1` consumers, and external agents need one audited place for keys, budgets, and usage.

### Decision
`packages/gateway` is an OpenAI-compatible gateway built on the Vercel AI SDK providers with virtual keys,
budgets, fallback chains, and cost logging. OpenRouter, LiteLLM, Cloudflare AI Gateway, OpenCode Zen, and the
Nous Portal proxy are OpenAI-compatible endpoints an admin points Perch at. None of them is deployed.

### Consequences
Engines receive native provider credentials for fidelity (prompt caching, thinking, provider params); the
gateway serves chat bots and external consumers.

## ADR-0004: CodeMirror 6 is the editor

- Status: accepted
- Date: 2026-09-12
- Task: spec §2, §5.1

### Context
The IDE needs an embeddable editor with diff decorations, ~40 languages, and a small bundle; Perch is not a
VS Code fork.

### Decision
CodeMirror 6 with `@codemirror/merge` and `@codemirror/language-data`. Final.

### Consequences
Diagnostics come from OpenCode's LSP integration where available; otherwise no LSP in v1. Tab completion is
optional and off by default.

## ADR-0005: better-auth + Postgres (PGlite in laptop mode); no Supabase, Redis, or object store by default

- Status: accepted
- Date: 2026-09-12
- Task: spec §2, §3.1

### Context
One data store keeps the deployment to four containers and lets the laptop binary run the same schema.

### Decision
better-auth with the Drizzle adapter (email + password, passkeys, generic OIDC). Drizzle ORM over `postgres`
(team) or `@electric-sql/pglite` (laptop) behind one `Db` type. Postgres carries data, full-text search,
vectors (pgvector), the job queue (`SKIP LOCKED`), and session events. The bus is in-process; presence and
rate limits are in memory; files live on a local volume or an S3-compatible bucket when `PERCH_S3_*` is set.

### Consequences
`Bus` and `Queue` interfaces exist from Phase 0 so a Redis adapter (Phase 5) changes nothing above them. Any
added service needs an ADR.

## ADR-0006: Subscriptions only through Lanes B and C, personal scope; Lane A for anything shared

- Status: accepted
- Date: 2026-09-12
- Task: spec §3.6

### Context
Vendors permit subscription use only inside their own or endorsed clients; Anthropic forbids Claude
subscriptions in third-party harnesses.

### Decision
Lane A (API keys and OpenAI-compatible endpoints) is the only lane for anything visible to more than one
person. Lane B (subscription OAuth inside OpenCode `/connect` or Hermes) and Lane C (official CLIs in the
terminal) are personal, live in the user's home volume, never in the vault, and are never proxied. Anthropic is
API key only in engines and bots; `cli-harness` for Claude Code stays off until terms are confirmed.

### Consequences
Perch never implements a vendor's OAuth itself and never spoofs a client id. Lanes are swappable when vendor
terms change.

## ADR-0007: AGPL-3.0 for apps, MIT for SDK-facing packages; DCO, no CLA

- Status: accepted
- Date: 2026-09-12
- Task: spec §0, §9.2, task 0.1

### Context
The license must keep a future hosted offering viable against resale while letting anyone build bots,
connectors, and integrations without copyleft questions. It has to be locked before the first external PR.

### Decision
AGPL-3.0 for `apps/*` (and, by default, every package not listed here). MIT for `packages/bot-sdk`,
`packages/ui`, `packages/events`, `packages/api-client`, `connectors/`, `templates/`. Contributors sign off
under the DCO; there is no CLA. The Perch name and logo are reserved for official builds.

### Consequences
Relicensing needs every contributor's consent, which is the point (see `PLEDGE.md`).

## ADR-0008: MCP-first connections with four registration lanes

- Status: accepted
- Date: 2026-09-12
- Task: spec §3.5

### Context
Self-hosters must connect to GitHub, Vercel, Supabase, Clerk, and any MCP or OAuth service without the Perch
project holding secrets and without registering an app for every vendor.

### Decision
Registration lanes tried in order: pre-registered client → CIMD (`/.well-known/oauth-client-metadata.json`
as `client_id`) → DCR (RFC 7591) → token paste. MCP OAuth discovery (RFC 9728 → RFC 8414/OIDC → PKCE) uses
the official MCP SDK client auth; plain OAuth2 providers use Arctic driven by `connectors/<provider>/manifest.yaml`.
A BYO OAuth app wizard covers vendors without CIMD or DCR (GitHub today, via a GitHub App).

### Consequences
`PERCH_PUBLIC_URL` drives every callback, webhook, and the CIMD document. Loopback redirects only in
single-user mode.

## ADR-0009: Tokens never leave Perch

- Status: accepted
- Date: 2026-09-12
- Task: spec §1.6, §3.5, §7.5

### Context
Engines, bots, and external agents must use connected services without ever seeing a credential (token
exfiltration, confused deputy).

### Decision
Engines, bots, and external agents reach connected services only through the MCP gateway (`/mcp/:connectionId`)
or `tools.call`, under a grant, with audit. Upstream calls carry the connection's own delegated token; Perch
never forwards a caller's bearer token upstream. Connections are personal by default; shared bots use them only
with `obo: true` and the invoking user; workspace connections need explicit grants.

### Consequences
The vault is the only place a token is decrypted; the gateway is the only path upstream. Tests assert that no
credential appears in runner traffic, logs, or transcripts.

## ADR-0010: Telemetry is opt-in, anonymous, and fully published

- Status: accepted
- Date: 2026-09-12
- Task: spec §9.2, `docs/telemetry.md`

### Context
Trust posture for a self-hosted product.

### Decision
No telemetry by default. An opt-in daily ping sends only `instance_id`, `version`, `os`, `arch`, `mode`,
`users_bucket`, `engines_enabled`, `local_models`. The field list lives in `docs/telemetry.md`; the wizard shows
a visible checkbox.

### Consequences
Never message content, prompts, or tokens. Any new field is a PR to `docs/telemetry.md` first.

## ADR-0011: Preview is a proxied iframe with a proxy-injected inspector; agent vision is Playwright MCP in the runner

- Status: accepted
- Date: 2026-09-12
- Task: spec §5.6

### Context
The dev server runs inside the runner; humans need to see it from any device and map clicks back to source;
agents need to verify their own changes.

### Decision
Every listening runner port is proxied as `https://<port>--<workspace>.preview.<domain>` (wildcard mode) or
`/p/<workspace>/<port>/` (path mode), gated by the Perch session, with WebSocket passthrough. The inspector is
a ~15 KB script injected by the proxy only for authenticated, nonce-bound preview-pane requests; source mapping
comes from the `@perch/inspector` dev plugin. `@playwright/mcp` in the runner gives agents eyes. No
remote-browser screen streaming.

### Consequences
The proxy reaches only the workspace's own runner ports; share links get a clean page; CSP is relaxed only for
the injected script on authenticated responses.

## ADR-0012: The wedge is the agents-as-teammates loop

- Status: accepted
- Date: 2026-09-12
- Task: spec §0, §5.7

### Context
Chat, editor, bot UX, and dev environments each have an incumbent; the loop nobody ships end to end,
self-hosted, with any agent and any model, is the product.

### Decision
Task appears in chat → an agent takes it in its own worktree, server-side → the human watches a preview from
a phone → approves the diff → it becomes a PR → the channel sees the outcome with cost and trace. Be #1 there;
be good enough and interoperable everywhere else. No feature wars with Mattermost or VS Code.

### Consequences
Every screen has to trace to one of the four UI references or to the wedge, or it doesn't ship.

## ADR-0013: ACP is the engine contract

- Status: accepted
- Date: 2026-09-12
- Task: spec §3.3, task 1.9

### Context
Agents keep multiplying; Perch must not write one adapter per vendor.

### Decision
A generic Agent Client Protocol client in the runner is the engine contract: any ACP Registry agent becomes an
engine. Bespoke adapters exist only for extras beyond ACP (OpenCode) or for runtimes that do not speak it yet
(Hermes). Perch tools reach agents through ACP's MCP passthrough.

### Consequences
The `Engine` interface and `EngineEvent` union in spec §3.3 are the internal shape; adapters translate into it
and the api persists every event to `session_events`.

## ADR-0014: Standards pack, not house formats

- Status: accepted
- Date: 2026-09-12
- Task: spec §0, §5.1, §5.3

### Context
Interoperability is cheaper than adoption.

### Decision
AGENTS.md is read at session start; bot skills use the Agent Skills format; `devcontainer.json` selects the
runner image; MCP in both directions (Perch consumes MCP servers and exposes `/mcp/perch`); the REST API is
OpenAPI-first with generated TypeScript and Python SDKs.

### Consequences
No proprietary skill, agent, or container format is introduced.

## ADR-0015: Laptop mode ships before public beta

- Status: accepted
- Date: 2026-09-12
- Task: spec §2, tasks 0.14, 1.21

### Context
The single binary is the first-touch story; compose is the team story.

### Decision
`perch` is one Bun-compiled binary per platform (linux x64/arm64, macOS arm64/x64, Windows x64) running api,
web, and an in-process runner on PGlite with the vector extension, on the same Drizzle schema.
`perch migrate --to-compose` moves a laptop instance to Postgres.

### Consequences
Every feature from Phase 1 on must work in-process on PGlite; the laptop smoke test runs on three OSes in CI.

## ADR-0016: Coexist with T3 Code — be the room, not the surface

- Status: accepted
- Date: 2026-09-12
- Task: spec §3.2, §10

### Context
A better GUI for one laptop's agents is someone else's product.

### Decision
No feature war for the laptop. The local runner (`perch runner connect`) is the bridge: a laptop, homelab, or
GPU box joins the room with its own subscriptions, CLIs, and code, and the comparison page says so.

### Consequences
`cli-harness` and Lane C exist to let people bring what they already pay for, in personal scope only.

## ADR-0017: UI/UX reference set — OpenCode, Slack, Cursor, Plane

- Status: accepted
- Date: 2026-09-12
- Task: spec §4

### Context
Perch needs four surfaces that each have a best-in-class reference; the job is to make them feel like one
product.

### Decision
OpenCode for the session-first transcript, Slack for navigation and messaging, Cursor for editor and review,
Plane for work management. One shell with five regions (rail, sidebar, main, panel, drawer), one composer, one
command palette, tokens as CSS variables with dark-first themes. Nothing ships that isn't traceable to one of
the four or to the wedge.

### Consequences
No VS Code fork, no Slack "More" sprawl, no Plane initiatives/teamspaces/dashboards before Phase 5, no Cursor
settings maze.

## ADR-0018: Phase 0 is delivered on one branch as one signed commit per task (spec deviation)

- Status: accepted
- Date: 2026-09-12
- Task: all of Phase 0

### Context
Spec §1.2 and §1.11 call for one branch and one PR per task, branched from `main`. When this session started
the remote repository had no commits and no branches, so there was no `main` to branch from or to target with a
PR, and the session's execution environment permits pushes only to the branch `claude/admiring-hamilton-lj14ir`.

### Decision
Phase 0 is built on `claude/admiring-hamilton-lj14ir` as a linear history with one conventional, DCO-signed
commit per task (and one per spike). Each commit carries what a PR description would: what and why, spec
sections, acceptance evidence, spec deviations, ADRs. `TASKS.md` marks a finished task `[x]` with its commit
subject instead of a PR link, and the separate `[~]` marking commit is folded into the task commit because the
branch never changes. Spike code lives under `spikes/` so each spike stays runnable. The Phase 0 report
(`docs/phase-0-report.md`) lists every commit, ADR, spike outcome, and deviation.

### Consequences
The human either makes this branch `main` or merges it through one PR once a base branch exists. From Phase 1
on, the per-task branch and PR workflow of spec §1.11 applies unchanged.
