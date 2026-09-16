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

## ADR-0019: TypeScript 7 (the native compiler) is the typechecker

- Status: accepted
- Date: 2026-09-12
- Task: 0.3

### Context
Spec §2 asks for strict TypeScript with `noUncheckedIndexedAccess` but pins no version. The registry's
`latest` is 7.0.2, the Go-native compiler; `@types/bun` 1.4.2 targets it (`ts6.0` tag).

### Decision
Pin `typescript` 7.0.2 and use it only for `tsc --noEmit` (Bun, Vite, and drizzle-kit transpile with their own
toolchains). `tsconfig.base.json` uses the TS 6/7 defaults explicitly: `module: ESNext`,
`moduleResolution: bundler`, `verbatimModuleSyntax`, `types: []` (each workspace opts into `bun` or DOM
types), no deprecated options.

### Consequences
Typechecking 22 workspaces takes about two seconds. If a library's declarations break under 7.x, the fallback
is to pin the last 5.9.x release for that workspace and record it here.

## ADR-0020: Playwright pinned to 1.62.1 so e2e and component tests share one runtime

- Status: accepted
- Date: 2026-09-12
- Task: 0.3

### Context
`@playwright/test` latest is 1.63.0 but `@playwright/experimental-ct-react` latest is 1.62.1, and Playwright
requires the component-testing package and the test runner to match exactly.

### Decision
Pin both to 1.62.1 until the component-testing package catches up; Renovate bumps them together. Playwright
is developer tooling and runs under Node in CI (`actions/setup-node`); no shipped Perch code targets Node.

### Consequences
Chromium must match the pinned version (`playwright install chromium` in CI); locally an
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` override points at a preinstalled build.

## ADR-0021: The ACP SDK is `@agentclientprotocol/sdk`

- Status: accepted
- Date: 2026-09-12
- Task: 0.3

### Context
The Agent Client Protocol's TypeScript SDK was first published as `@zed-industries/agent-client-protocol`
(last 0.4.5) and now lives at `@agentclientprotocol/sdk` (1.4.0).

### Decision
Pin `@agentclientprotocol/sdk` 1.4.0 in `packages/engines` and `apps/runner`. Spike 0.4.2 validates it on Bun.

### Consequences
Registry agents are spawned and driven through this package only; the older name is not used.

## ADR-0022: The TypeScript SDK is generated with openapi-typescript and runs on openapi-fetch

- Status: accepted
- Date: 2026-09-12
- Task: 0.3, 0.7

### Context
Spec §7.1 makes `/api/openapi.json` the source of truth that produces the TypeScript and Python SDKs but
names no generator.

### Decision
`packages/api-client` generates `src/schema.d.ts` from the OpenAPI document with `openapi-typescript` 7.13.0
and exposes a typed client built on `openapi-fetch` 0.17.0 (a 6 KB fetch wrapper, no codegen of runtime
code). The Python SDK is generated at release time with `openapi-python-client` in the release workflow
(Python is a release-time tool, not repository code).

### Consequences
Regenerating the SDK is `bun run --filter @perch/api-client generate`; CI fails when the committed schema
drifts from the served document.

## ADR-0023: The unified `radix-ui` package instead of per-primitive `@radix-ui/react-*` packages

- Status: accepted
- Date: 2026-09-12
- Task: 0.3, 0.11

### Context
shadcn/ui now targets the single `radix-ui` package; the per-primitive packages remain but double the
version surface.

### Decision
Pin `radix-ui` 1.6.7 in `packages/ui`; shadcn base components import primitives from it.

### Consequences
One version to bump; tree-shaking keeps the bundle equivalent.

## ADR-0024: drizzle-kit stays on the 0.31 stable line

- Status: accepted
- Date: 2026-09-12
- Task: 0.3, 0.5

### Context
`drizzle-orm` latest is 0.45.2; `drizzle-kit` latest is 0.31.10 while 1.0 is still a release candidate.

### Decision
Pin `drizzle-kit` 0.31.10 (dev, `packages/db`) and `drizzle-orm` 0.45.2. Migrations are generated with the
stable kit and embedded into the packages so the compiled laptop binary needs no migrations folder on disk.

### Consequences
Renovate opens the 1.0 major as its own PR when it ships; the migration files it produces are reviewed then.

## ADR-0025: UUID v7 comes from `Bun.randomUUIDv7()`

- Status: accepted
- Date: 2026-09-12
- Task: 0.3, 0.5

### Context
Spec §6 requires uuid v7 primary keys. Bun ships a native generator; the `uuid` package would be one more
dependency for one function.

### Decision
`packages/db` exports `newId()` wrapping `Bun.randomUUIDv7()` and uses it as the `$defaultFn` of every `id`
column. Ids are generated in the application, never by the database, so both drivers behave the same.

### Consequences
`packages/db` requires the Bun runtime (it already does for PGlite tests); `apps/web` never generates ids.

## ADR-0026: `oauth2-mock-server` is the OIDC test double

- Status: accepted
- Date: 2026-09-12
- Task: 0.3, 0.8

### Context
Task 0.8 must prove the generic OIDC flow end to end without a real identity provider in CI.

### Decision
Root dev dependency `oauth2-mock-server` 9.2.0 runs an in-process OpenID provider during the auth Playwright
spec. It never ships.

### Consequences
The OIDC spec is hermetic; Clerk-as-login is verified against the same flow with real settings in Phase 2.

## ADR-0027: `t("key")` is an in-house typed lookup, not i18next

- Status: accepted
- Date: 2026-09-12
- Task: 0.3, 0.11

### Context
Spec §9.1 requires every user-facing string to go through `t("key")` from day one with only `en`. A full i18n
framework would add runtime, pluralization DSLs, and bundle weight before there is a second locale.

### Decision
`packages/ui/src/i18n` exports `t(key, params?)` typed against the keys of `en.json`, with `{name}`
interpolation and a per-locale catalog map. `PERCH_DEFAULT_LOCALE` selects the catalog.

### Consequences
Adding a locale is adding a JSON file; a missing key is a type error. Pluralization beyond simple `{count}`
forms is an ADR when it is needed.

## ADR-0028: The CLI publishes to npm as `perch-dev` with the binary `perch`

- Status: accepted
- Date: 2026-09-12
- Task: 0.3, 0.14

### Context
Spec §8 says `npx perch`, but the npm name `perch` is already taken by an unrelated package (1.0.0).

### Decision
`apps/cli` is published as `perch-dev` (available, matches the `get.perch.dev` installer domain) with
`bin: { perch: … }`. The installer (`curl -fsSL get.perch.dev | sh`), Homebrew, winget, AUR, and nix remain
the primary paths; `npx perch-dev@latest init` is the npm path.

### Consequences
Docs say `npx perch-dev`. If the maintainer obtains the `perch` name, this ADR is superseded.

## ADR-0029: Spike 0.4.1 — PTY on Bun: node-pty fails, bun-pty is the PTY

- Status: accepted (spike outcome: fallback)
- Date: 2026-09-13
- Task: 0.4.1

### Context
Spec §9.3: node-pty must open a shell, resize, and survive 1,000 writes; the listed fallback is bun-pty per
platform.

### Decision
On Bun 1.3.11 / linux x64, `node-pty` 1.1.0 spawns and echoes but `resize()` throws `ioctl(2) failed,
EBADF` and sustained writes fail with `EBADF`, because Bun's `net.Socket({ fd })` does not keep node-pty's
master fd usable. `bun-pty` 0.4.10 passes the whole scenario (open, resize, 1,000 writes in ~0.5 s, clean
exit, kill). bun-pty is the PTY in `apps/runner` on every Unix platform; node-pty is removed from the runner
and remains only as an opt-in probe in `spikes/pty`. The CI matrix (`spikes.yml`: ubuntu, ubuntu-arm, macOS,
Windows) records the other platforms; a platform where bun-pty fails and node-pty passes gets a per-platform
switch and an update to this ADR.

### Consequences
The terminal (task 1.7) targets bun-pty's API (`spawn`, `onData`, `onExit`, `write`, `resize`, `kill`).
Windows is verified by the matrix, not here.

### Update (2026-09-14): the matrix outcome
The first `spikes.yml` run (PR #1) confirms the decision on every platform: bun-pty passes the whole
scenario on ubuntu x64, ubuntu arm64, macOS (arm64), and Windows (ConPTY, 13 s for the 1,000 writes);
node-pty fails on all four under Bun (Linux x64 and arm64: `EBADF` on write; macOS: `posix_spawnp
failed`; Windows: `ERR_SOCKET_CLOSED` on the first write). The node-pty probe is therefore an
informational step in `spikes.yml` (`continue-on-error`), never the gate: the gate is bun-pty, which is
what Perch ships. A platform where the probe starts passing and bun-pty fails would reopen this ADR.

## ADR-0030: Spike 0.4.2 — ACP handshake: the SDK works on Bun; real agents gated on credentials

- Status: accepted (spike outcome: pass, real agents deferred to credentials)
- Date: 2026-09-13
- Task: 0.4.2

### Context
Spec §9.3: the ACP SDK client initializes Gemini CLI and Codex, streams a session, and answers a permission.

### Decision
`@agentclientprotocol/sdk` 1.4.0 is verified on Bun on both halves: a stub agent (`spikes/acp/agent.ts`,
built with the SDK's agent app over stdio ndjson) and the client (`initialize` → `buildSession` → `prompt` →
`nextUpdate` → `requestPermission` answered → `end_turn`), with `allow` and `deny` both reaching the agent.
Gemini CLI and Codex need vendor keys that are not in this environment; the same client runs against any
registry agent through `PERCH_SPIKE_ACP_AGENT`, and task 1.9's acceptance runs it in CI with secrets.

### Consequences
The ACP adapter (task 1.9) is built on the fluent `client()` API of SDK 1.4; the deprecated
`ClientSideConnection` is not used. No SDK pin change was needed (the listed fallback).

## ADR-0031: Spike 0.4.3 — OpenCode SDK: serve, sessions, events, diff work; a streamed reply needs a key

- Status: accepted (spike outcome: pass, credentialed prompt deferred to a key)
- Date: 2026-09-13
- Task: 0.4.3

### Context
Spec §9.3: `opencode serve` + SDK must create a session, send a prompt, stream events, apply a diff, list
sessions; the fallback is driving OpenCode through ACP only.

### Decision
`@opencode-ai/sdk` 1.18.30 launches the pinned `opencode` 1.18.30 binary on Bun; session create, list, diff,
delete, the SSE event stream, and a credential-less prompt (returns, does not hang) all work. The streamed
reply and post-turn diff run with `OPENAI_API_KEY` or `PERCH_SPIKE_OPENCODE_MODEL`. The OpenCode adapter
(task 1.10) proceeds; the ACP-only fallback is not taken. The binary is pinned in the runner image; the
`opencode-ai` npm package is used only by the spike, whose `prepare-binary` script runs its postinstall
(Bun does not run untrusted install scripts).

### Consequences
The adapter uses the `/session`, `/session/{id}/message`, `/session/{id}/diff`, and `/event` surface of
this SDK version; a version bump reruns the spike first.

## ADR-0032: Spike 0.4.4 — PGlite carries the schema in memory; pgvector is a separate package

- Status: accepted (spike outcome: pass)
- Date: 2026-09-13
- Task: 0.4.4

### Context
Spec §9.3: vector, tsvector, and SKIP LOCKED must pass the packages/db suite in memory; the fallback is
embedded Postgres for laptop mode.

### Decision
`@electric-sql/pglite` 0.5.8 passes: `vector(1024)` with an HNSW index and `<=>` search, a generated
`tsvector` column with GIN and `plainto_tsquery`, `citext`, `FOR UPDATE SKIP LOCKED` in a transaction, and
advisory locks. In this PGlite line pgvector ships as `@electric-sql/pglite-pgvector` 0.0.9 (export `vector`)
rather than inside the core package; citext comes from `@electric-sql/pglite/contrib/citext`. No embedded
Postgres.

### Consequences
`packages/db` depends on `@electric-sql/pglite-pgvector`; the PGlite harness loads both extensions.
PGlite is single-connection, so concurrent queue claims are tested on the Postgres service container in CI.

## ADR-0033: Spike 0.4.5 — QuickJS sandbox on the sync build with promise-based host tools

- Status: accepted (spike outcome: pass)
- Date: 2026-09-13
- Task: 0.4.5

### Context
Spec §9.3: a code bot runs with a 200 ms CPU budget, no host access, and a tool round trip; the fallback is
runner containers only.

### Decision
`quickjs-emscripten` 0.32.0's sync release build (`getQuickJS()`) passes: the interrupt handler stops an
infinite loop within the budget, no host globals exist inside the sandbox, a 4 MB memory limit throws, and
host tools are exposed as functions returning a QuickJS promise (`ctx.newPromise()`) settled from the host
with `runtime.executePendingJobs()`, which gives `await tool(name, args)` inside bot code. The asyncify build
is not used: on Bun 1.3.11 its runtime disposal fails with `QuickJSRuntime not found when trying to free
HostRef`.

### Consequences
`packages/bots` builds the code-bot sandbox on this pattern (task 3.x); runner containers remain the path
for heavy jobs, not the fallback for all code bots.

## ADR-0034: Spike 0.4.6 — better-auth on Bun with the Drizzle adapter; generic OAuth rides the social routes

- Status: accepted (spike outcome: pass at the HTTP level; browser passkeys in task 0.8)
- Date: 2026-09-13
- Task: 0.4.6

### Context
Spec §9.3: email + password, passkeys, and generic OIDC must pass; the fallback is pinning or patching.

### Decision
better-auth 1.7.4 + `@better-auth/passkey` 1.7.4 with the Drizzle adapter on PGlite run on Bun through
`auth.handler(Request)`: sign up, sign in, session, wrong password → 401; passkey registration options and
listing; generic OIDC with discovery, authorization code + PKCE, callback, and a session carrying the
provider's claims (against an in-process `oauth2-mock-server`). Two facts shape task 0.8: better-auth 1.7
registers generic OAuth providers as social providers, so the routes are `POST /sign-in/social` and
`GET /callback/:providerId` (no `/sign-in/oauth2`); and the `auth_*` tables use better-auth's field names
verbatim. No pin or patch was needed.

### Consequences
The WebAuthn ceremony itself (browser + virtual authenticator) is the Playwright spec of task 0.8. The
`auth_*` Drizzle tables from `spikes/better-auth/schema.ts` move into `packages/db` in task 0.5.

## ADR-0035: Spike 0.4.7 — dockerode from Bun passes in CI; execs never hijack the connection

- Status: accepted (spike outcome: pass in CI, with one restriction)
- Date: 2026-09-13; CI result added 2026-09-14
- Task: 0.4.7

### Context
Spec §9.3: the supervisor creates, limits, execs into, and removes a runner container; the fallback is a
supervisor on Node LTS in its own image. The Phase 0 build environment has no Docker daemon, so the spike
skips there and runs wherever a daemon exists: the `check` job of `ci.yml` and `spikes.yml`, both on the
ubuntu runner.

### Decision
The first CI run showed `dockerode` 5.0.1 working from Bun for the daemon version, the image pull with
progress, create with `NanoCpus`/`Memory`/`PidsLimit`, start, and inspect. The one failure was
`exec.start({ hijack: true })`: a hijacked exec asks the daemon to upgrade the connection
(`101 Switching Protocols`, raw TCP afterwards), and Bun's `node:http` client returns that 101 as an
ordinary response, which docker-modem reports as an error. The spike therefore execs without a hijack
(`hijack: false`, no stdin) and demultiplexes the plain streamed response, which is the shape the
supervisor needs: one-shot commands with captured output. Interactive stdin over the Docker socket
(hijacked exec or attach) appears nowhere in the design; PTYs and engine sessions run through the runner
protocol (§7.6) over the runner's own WebSocket. Task 1.2 builds the supervisor on `dockerode` in
`apps/api`; the Node LTS fallback is not taken.

### Consequences
Nothing in the supervisor may rely on a hijacked Docker connection. Should one ever be needed, the
fallback is a raw request over the Unix socket with `Bun.connect`, recorded in a new ADR. `spikes.yml`
re-verifies the spike per platform on dispatch.

## ADR-0036: Spike 0.4.8 — Caddy wildcard is deferred; path-mode previews are the default

- Status: accepted (spike outcome: deferred; fallback is the default)
- Date: 2026-09-13
- Task: 0.4.8

### Context
Spec §9.3: a DNS-challenge wildcard certificate must issue in CI; the fallback is path-mode previews.

### Decision
Issuing needs a real domain and a DNS provider token that neither the build environment nor the CI secrets
have. The spike ships the Caddyfile shape, `Dockerfile.caddy` (Caddy with cloudflare, route53, digitalocean,
hetzner DNS modules), a compose stack, and `check.ts`; `spikes.yml` runs it on `workflow_dispatch` when
`CADDY_DNS_TOKEN` and the preview domain variables are set. Until then previews run in path mode
(`/p/<workspace>/<port>/`), which spec §8 already prescribes whenever `PERCH_PREVIEW_DOMAIN` is unset.

### Consequences
Task 1.18 ships path mode first and wildcard mode behind `PERCH_PREVIEW_DOMAIN`; the shipped
`deploy/Dockerfile.caddy` is the spike's image.

## ADR-0037: Spike 0.4.9 — the preview tunnel works: Vite HMR end to end over an outbound runner socket

- Status: accepted (spike outcome: pass)
- Date: 2026-09-13
- Task: 0.4.9

### Context
Spec §9.3: HMR for a Vite app on a local runner must work end to end through the api; the fallback is a
"local only" badge.

### Decision
A Bun.serve prototype of §7.6 `http.open` (api mints a stream token, the runner opens
`/api/runner/stream/<token>`, HTTP as head + body frames, WebSocket upgrades relayed frame by frame with the
subprotocol preserved) carries a real Vite 8 dev server's `index.html`, transformed modules, the `vite-hmr`
handshake, and a live update after a file edit. No fallback. The dev server runs under Node in the spike
because it stands in for the user's project process; Vite does not load under Bun's isolated store, which
does not affect Perch code.

### Consequences
Task 1.19 implements `http.open` on the runner protocol with this frame model; task 1.18's path-mode proxy
and the tunnel share the same relay code.

## ADR-0038: Spike 0.4.10 — cloudflared is deferred; Tailscale Serve/Funnel is the documented alternative

- Status: accepted (spike outcome: deferred)
- Date: 2026-09-13
- Task: 0.4.10

### Context
Spec §9.3: a callback and a webhook must reach the api through the tunnel; the fallback is documenting
Tailscale.

### Decision
A Cloudflare tunnel token is not available here or in CI secrets. The spike ships the `tunnel` compose
profile and `check.ts` (callback-shaped GET and webhook-shaped POST through `PERCH_PUBLIC_URL`), gated in
`spikes.yml` on `TUNNEL_TOKEN`. `spikes/cloudflared/README.md` documents Tailscale Serve (tailnet HTTPS) and
Funnel (public HTTPS) as the alternative; both keep `PERCH_PUBLIC_URL` stable, which is all the CIMD document
and connector callbacks need.

### Consequences
The setup wizard (task 0.13) lists all four callback options; the tunnel profile stays in the compose file.

## ADR-0039: Migrations are embedded as text imports and applied under a session-level advisory lock

- Status: accepted
- Date: 2026-09-13
- Task: 0.5

### Context
Spec §9.1 says migrations are generated with drizzle-kit, committed, and run on boot under an advisory lock.
The compiled laptop binary has no migrations folder on disk, and drizzle's stock migrators read files
from disk; nested transactions are not available on PGlite, so a wrapping transaction with
`pg_advisory_xact_lock` cannot host drizzle's migrator.

### Decision
`scripts/embed-migrations.ts` regenerates `src/migrations/index.ts` from `drizzle/meta/_journal.json`,
importing each SQL file with `with { type: "text" }` so Bun embeds it. `migrateOnOneConnection(db)` builds
drizzle's `MigrationMeta[]` from those sources and calls the dialect's own `migrate` on a database bound to
exactly one connection, holding `pg_advisory_lock(7331003)` on that connection for the duration; every
`DbHandle` exposes `migrate()` (PGlite is one connection; Postgres opens a dedicated `max: 1` client).
`__drizzle_migrations` in the `drizzle` schema remains the record of what was applied.

### Consequences
`bun run db:generate` is `drizzle-kit generate` followed by the embed step, and CI fails when the embedded
index drifts from the journal (the invariant test lands with 0.15). Concurrent api instances boot safely.

## ADR-0040: messages.text_search is generated from the jsonb blocks with jsonpath

- Status: accepted
- Date: 2026-09-13
- Task: 0.5

### Context
Spec §6 declares `messages.text_search tsvector generated` but not from which column; the message body
lives only in the `blocks` jsonb array.

### Decision
`text_search` is `to_tsvector('english', jsonb_path_query_array(blocks, '$[*].text') || ' ' ||
jsonb_path_query_array(blocks, '$[*].code'))`: every block's `text` field and every code block's `code`
field are indexed, with no duplicated plain-text column. The GIN index sits on the generated column.

### Consequences
Interactive block labels (`text` on buttons, forms, approve/deny) are searchable too, which is what a
human expects from Slack-style search; the `english` configuration is a Phase 2 setting once locales
matter (task 2.4).

## ADR-0041: jobs rows carry an optional `key` so cron schedules are upserts

- Status: accepted
- Date: 2026-09-13
- Task: 0.6

### Context
Spec §6 lists the jobs columns (queue, payload, run_at, attempts, max_attempts, locked_by, locked_at,
last_error, cron) but gives cron rows no stable identity; re-registering a schedule on every boot would
duplicate rows.

### Decision
`jobs.key text` (nullable, unique where not null) identifies a schedule; `queue.schedule({ key, cron, … })`
upserts on it and `unschedule(key)` removes it. One-off jobs leave it null. The rest of the table follows
the spec exactly; the claim query and the partial `(queue, run_at) where locked_at is null` index are as
specified.

### Consequences
A small schema extension recorded here and in `packages/db/src/schema/jobs.ts`; migration `0002_jobs`.

## ADR-0042: The SDK generator runs on TypeScript 5.9 pinned inside packages/api-client

- Status: accepted
- Date: 2026-09-13
- Task: 0.7

### Context
`openapi-typescript` 7.13 builds its output with the TypeScript compiler API (`ts.factory`). The
TypeScript 7.0 package (ADR-0019) ships the native compiler and no longer exposes that API, so generation
crashed with `Cannot read properties of undefined (reading 'createKeywordTypeNode')`.

### Decision
`packages/api-client` declares `typescript` 5.9.3 as its own dev dependency. Bun's isolated linker resolves
`openapi-typescript`'s peer to that copy inside the workspace while every other workspace keeps 7.0.2 for
`tsc --noEmit`. No other package touches TypeScript 5.

### Consequences
`bun run sdk:generate` works from a clean install; Renovate keeps the 5.9 line pinned for this workspace
until `openapi-typescript` supports the 7.x package, at which point this ADR is superseded.

## ADR-0043: Perch-Version is enforced: an unknown version is a validation error

- Status: accepted
- Date: 2026-09-13
- Task: 0.7

### Context
Spec §7.1 versions the REST contract by the `Perch-Version` header but does not say what happens when a
client sends a version the server does not know.

### Decision
The api always answers with `Perch-Version: <current>`. A request without the header gets the current
contract. A request with a version outside `SUPPORTED_API_VERSIONS` gets a 422 `validation` error listing
the supported versions, so a client pinned to a future or retired contract fails loudly instead of
silently getting a different shape. The generated SDK sends the version it was generated from.

### Consequences
Introducing a breaking contract change means adding a version to the supported list and keeping the old
behaviour behind it until it is retired with a changeset.

## ADR-0044: An unauthenticated request is `forbidden` (403) with `details.reason = "unauthenticated"`

- Status: accepted
- Date: 2026-09-13
- Task: 0.8

### Context
Spec §7.8 fixes the error codes and their statuses (`forbidden` → 403) and has no `unauthorized` / 401
code. Routes still need to tell a client that has no session or token apart from one that has the wrong
role.

### Decision
`requireUser` throws `PerchError.forbidden("authentication required", { reason: "unauthenticated" })`.
The status and code stay inside the §7.8 table; the `reason` detail lets the web client redirect to
`/sign-in` while an authenticated-but-not-allowed call carries no such reason. Authentication itself is
one middleware on `/api/*`: a `pat_` bearer token resolves through `api_tokens` (sha256 hash lookup),
otherwise better-auth's session cookie resolves through `auth.api.getSession`. `/api/auth/*` is handed to
better-auth before that middleware runs.

### Consequences
No 401 or `WWW-Authenticate` challenge is ever emitted; SDKs treat `forbidden` + `reason:
unauthenticated` as "sign in". Task 0.9 layers `authorize()` (roles) on top of this identity step.

## ADR-0045: api tokens are `pat_` + 32 random bytes, stored as a sha256 hash, shown once

- Status: accepted
- Date: 2026-09-13
- Task: 0.8

### Context
Spec §6 stores `api_tokens.token_hash` and §7.1 accepts api tokens as bearer credentials, but neither
fixes the token format nor the hashing.

### Decision
A token is `pat_` followed by 32 bytes from `crypto.getRandomValues` in base64url. Only
`sha256(token)` is stored; the plaintext is returned once in the `POST /api/me/tokens` response
(`ApiTokenCreated.token`) and never listed again. Lookup is by hash; expired tokens resolve to nothing;
`last_used_at` is written at most once a minute per token to keep reads cheap. Scopes are the §6
`API_TOKEN_SCOPES` list; enforcement of scopes per route arrives with `authorize()` in 0.9. Tokens are
created only from a session (not from another token); listing and revoking work from either.

### Consequences
Rotating a token means creating a new one and revoking the old; there is no reveal endpoint. The `pat_`
prefix makes secret scanners and the bearer middleware able to recognise Perch tokens without a lookup.

## ADR-0046: Invites are 7-day hashed links returned to the inviter and logged until SMTP exists

- Status: accepted
- Date: 2026-09-13
- Task: 0.8

### Context
Spec §6 has `invites(token_hash, email, role, expires_at, accepted_at)` and §8 makes `PERCH_SMTP_URL`
optional with a console transport. The acceptance criterion is "invite accepted" end to end.

### Decision
- `POST /api/workspaces/{ws}/invites` (owner or admin; only an owner can invite an owner) creates a
  token `inv_` + 24 random bytes (base64url), stores its sha256 hash, sets a 7-day expiry, and returns
  `accept_url = <PERCH_PUBLIC_URL>/invite/<token>` to the inviter. The link is also logged at `info`
  (console transport) until email delivery lands with `PERCH_SMTP_URL`.
- `GET /api/invites/{token}` is public and returns the workspace name and slug, the role, a masked
  email, and a `pending | accepted | expired` status, so the web page can render before sign-in.
- `POST /api/invites/{token}/accept` requires a session whose email matches the invite (case-insensitive);
  it creates the membership once, marks the invite accepted, and publishes `member.added`.
  A second accept is `conflict`; a different user is `forbidden`; a non-member asking about a
  workspace gets `not_found` rather than a hint that it exists.

### Consequences
Possessing the link is not enough to join: the invited email must sign in, so a leaked log line does
not hand out a membership. Invites carry no workspace-scoped roles beyond owner/admin/member (§6).

## ADR-0047: Profile rows come from better-auth hooks; handles and slugs get numeric suffixes

- Status: accepted
- Date: 2026-09-13
- Task: 0.8

### Context
Spec §6 keeps the Perch `users` profile (handle, locale, tz, avatar) separate from better-auth's
`auth_user`, and requires unique handles and workspace slugs, but does not say how they are chosen.

### Decision
`databaseHooks.user.create.after` calls `ensureProfile`, which inserts the `users` row exactly once per
auth user (idempotent on `auth_user_id`) for every sign-up path: email + password, OIDC, and future
providers. The handle is the email's local part lowered and reduced to `[a-z0-9-]`, then `-2`, `-3`, …
until free. Workspace slugs derived from a name (`POST /api/workspaces` without `slug`) get the same
suffixing; an explicit `slug` must be free or the call is `conflict`. `PATCH /api/me` validates handles
against `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$` and answers `conflict` when taken.

### Consequences
Sign-up never fails on a handle collision. Renaming a handle is explicit and validated; nothing else
depends on the handle being derived from the email.

## ADR-0048: Passkeys bind to the public origin; better-auth logs ride pino; the Vite origin is trusted in laptop mode

- Status: accepted
- Date: 2026-09-13
- Task: 0.8

### Context
`@better-auth/passkey` needs an `rpID` and `origin`; better-auth has its own logger; the Vite dev server
runs on a different origin (5173) than the api (3000) and better-auth rejects untrusted origins.

### Decision
`rpID` is the hostname of `PERCH_PUBLIC_URL` and `origin` is `PERCH_PUBLIC_URL` itself, so a passkey
registered on an instance keeps working across deploys of the same URL and never across instances.
better-auth's `logger.log` is routed into the pino logger (same redaction, same format) and disabled when
`PERCH_LOG_LEVEL=silent`. In laptop mode `http://localhost:5173` and `http://127.0.0.1:5173` are added
to `trustedOrigins`; team mode trusts only the public URL. The generic OIDC provider (`PERCH_OIDC_*`) is
configured through better-auth's `genericOAuth` plugin with PKCE and discovery, and the web client
starts it with `signIn.social({ provider: "oidc" })` (ADR-0034).

### Consequences
Changing `PERCH_PUBLIC_URL` invalidates existing passkeys (they are bound to the old rpID); the setup
wizard (0.13) warns about this. Password-reset links use the console transport until SMTP lands.

## ADR-0049: `GET /api/instance` publishes the sign-in methods an instance offers

- Status: accepted
- Date: 2026-09-13
- Task: 0.8

### Context
The sign-in page must know whether to show the single-sign-on button before anyone is signed in. Spec §7.1
lists no such endpoint; `/api/version` is about the build, not configuration.

### Decision
A public `GET /api/instance` returns `public_url`, `mode`, and `auth: { email_password, passkeys, oidc }`.
It is additive to §7.1 and is the endpoint the setup wizard (0.13) extends with `setup_complete`.

### Consequences
Instance facts that the client needs pre-auth go here, never into `/api/version`. Nothing secret is ever
returned from it (no issuer, no client id).

## ADR-0050: `routeTree.gen.ts` is committed; Playwright specs are `e2e/*.e2e.ts` against port 3999

- Status: accepted
- Date: 2026-09-13
- Task: 0.8
- Supersedes: the "git-ignored" note for `@tanstack/router-plugin` in ADR-0019/`docs/dependencies.md`

### Context
The TanStack Router plugin generates `apps/web/src/routeTree.gen.ts` during `vite build`/`vite dev`.
`bun run typecheck` runs `tsc --noEmit` per workspace without a build step, so an ignored file makes
typecheck depend on a prior build. Playwright discovers `*.spec.ts`, and so does `bun test`, which then
crashes on Playwright's `test()`.

### Decision
- The generated route tree is committed (Biome ignores it; the plugin rewrites it on every build).
- Playwright lives at the repo root: `playwright.config.ts` with `testDir: e2e`, `testMatch: *.e2e.ts`,
  two projects (desktop 1440×900 and a 390×844 mobile profile), and a `webServer` of
  `scripts/e2e-server.ts`, which builds `apps/web` (skip with `E2E_SKIP_BUILD=1`) and runs the api in
  laptop mode on port 3999 with `pglite://memory`, a throwaway data dir, and `PERCH_PUBLIC_URL` set so
  passkeys bind to `localhost`.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE` overrides the browser binary for environments where Playwright cannot
  download its Chromium (the pinned 1.62.1 expects revision 1234; the build container ships 1194, which
  runs the suite cleanly). CI installs the matching browser instead.
- Passkeys in tests use Chromium's virtual authenticator through CDP (`WebAuthn.addVirtualAuthenticator`
  with a resident, user-verified CTAP2 internal authenticator).

### Consequences
`bun run e2e` works from a clean checkout after `bun install` plus a browser. Every browser flow is
exercised at both spec viewports (§1.7) by default.

## ADR-0051: RBAC v0 is a role matrix plus token scopes in `@perch/policy`, hidden behind not_found for non-members

- Status: accepted
- Date: 2026-09-13
- Task: 0.9

### Context
Spec §6 fixes the three membership roles (owner, admin, member) and §9.1 requires
`authorize(ctx, action, resource)` from `packages/policy` in every handler, but the spec does not enumerate
which role may do what, nor how api-token scopes interact with roles. The policy.yaml evaluator (§5.7) is a
Phase 2 task (2.11) and needs the same entry point.

### Decision
`@perch/policy` exports a pure `authorize(ctx, action, resource)` over a role matrix (`ROLE_MATRIX`) and
per-action token scopes (`SCOPE_FOR_ACTION`):

| action | owner | admin | member | token scope |
|---|---|---|---|---|
| workspace.read, members.read | yes | yes | yes | read |
| workspace.update, members.invite, members.update_role, audit.read | yes | yes | no | admin |
| members.remove | yes | yes | self only | admin |
| workspace.delete | yes | no | no | admin |

Rules on top of the matrix: only an owner touches owners (removing, demoting, or promoting to owner);
nobody changes their own role; anyone may remove themselves; the last owner can neither leave nor be
demoted (a `conflict` with `reason: last_owner`, enforced in the service). `admin` implies `write`
implies `read`; sessions carry no scopes and are limited by role alone. The api's `authorize()` wrapper
loads the membership, sets `workspace_id` on the request log, turns `not_member` into `not_found`
(a workspace's existence is never revealed to outsiders) and every other denial into `forbidden` with
`details.reason` (`role`, `scope`, `self`) and `details.action`.

### Consequences
Every new workspace-scoped route adds its action to the matrix and calls `authorize()` first; repositories
still scope every query by workspace id (§9.1). Instance-level administration (`/api/admin/*`) is a
separate, later concept and is not modelled as a workspace role.

## ADR-0052: The audit log is an in-process bus subscriber with a workspace-scoped read endpoint

- Status: accepted
- Date: 2026-09-13
- Task: 0.9

### Context
Spec §7.7: "WS fan-out, inbox, webhooks, and audit subscribe to the bus; features never write the audit log
directly", and `audit.logged` is itself a catalog event. Spec §7.1 lists only `/api/admin/audit`, an
instance-level endpoint, while task 0.9's criterion is that audit rows appear for workspace actions.

### Decision
`apps/api/src/audit/subscriber.ts` subscribes to `*` on the bus and writes one `audit_log` row per
workspace-scoped event (payloads carrying `workspaceId`), then publishes `audit.logged` for it. Excluded
as ephemeral: `typing`, `presence.changed`, `read_state.updated`, `session.delta`, `session.usage`,
`usage.recorded`, and `audit.logged` itself (no loops). The target is derived from the event name:
`member.*` → the user, `workspace.*` → the workspace, otherwise `<head>.*` → `<head>Id` when the payload
has one. `details` is the payload minus `workspaceId` plus the request id; `ip` and the request id come
from the envelope's `meta` (ADR-0053); the actor is the envelope's actor or `system`. The bus awaits
subscribers, so a handler's response is sent only after its audit row exists.
`GET /api/workspaces/{ws}/audit?before&limit&action` (owners and admins) reads the rows newest first;
`/api/admin/audit` (instance-wide) arrives with the admin settings work. `audit_log` is migration
`0003_audit` with exactly the §6 columns (a single `ts`, no updated_at).

### Consequences
Multi-node deployments (Redis bus, ADR-0005) must run the subscriber on exactly one node or make the insert
idempotent on the event id; that is part of the Phase 5 bus adapter. Adding an event to the catalog audits
it automatically unless it is added to the exclusion set.

## ADR-0053: Bus envelopes carry `meta` (request id, client ip) beside the actor

- Status: accepted
- Date: 2026-09-13
- Task: 0.9

### Context
The §6 `audit_log` has an `ip` column, but bus events (§7.7) carry only a payload and an actor; the audit
subscriber has no request context of its own.

### Decision
`BusEvent` gains an optional `meta: { requestId?, ip? }` (`eventMetaSchema` in `@perch/events`;
`PublishOptions.meta` in `@perch/bus`). Handlers build it once with `actorOf(c)` (actor + meta) and pass it
through services to `bus.publish`; `ip` prefers `X-Forwarded-For`/`X-Real-IP` (set by Caddy) and falls
back to the socket address. Nothing else from the request (headers, body, tokens) ever enters the
envelope.

### Consequences
Every service that publishes takes a `by: ActorContext`; tests can assert audit rows carry the caller and
ip. WS fan-out (0.10) strips `meta` before sending events to clients.

## ADR-0054: /api/ws authorizes per topic, sends a presence snapshot on subscribe, and hides the actor

- Status: accepted
- Date: 2026-09-13
- Task: 0.10

### Context
Spec §7.2 fixes the client ops (subscribe, unsubscribe, ping, typing, presence, resume) and the server
envelope `{ type, topic, seq, ts, payload }`, but not who may subscribe to which topic, how a tab learns
who is already online, or what happens when a resume falls off the replay buffer.

### Decision
- Upgrades require a signed-in user (cookie or bearer); otherwise the §7.8 `forbidden` body.
- Topics are authorized on subscribe: `ws:<id>` needs a membership, `channel:<id>` needs the channel's
  workspace membership and, for non-public channels, a channel membership, `inbox:<user>` must be the
  caller's own, `session:<id>` is refused until sessions land (task 1.x). Denials are `error` control
  envelopes on that topic with `not_found` (hidden existence), `forbidden`, or `validation`.
- Control envelopes share the §7.2 shape with `topic: ""` and `seq: 0` unless they are about a topic;
  `subscribed` carries the topic's current seq so a client knows where it stands. Subscribing to
  `ws:<id>` also sends `presence_snapshot` (`{ workspaceId, users: [{ userId, status }] }`), a control
  type added to the catalog's `WS_CONTROL_TYPES`.
- Presence is per user per workspace, counted per connection: a second tab does not re-announce,
  "online" from any tab beats "away", and only the last tab closing publishes `offline`.
  `presence.changed` and `typing` are real bus events (spec §7.7) but are not audited (ADR-0052).
- `resume { topic, after_seq }` replays from the bus buffer in order, then confirms with `subscribed`
  (`resumed: true, replayed: n`, seq = latest); a seq older than the buffer answers `resync { oldest,
  latest }` and the client refetches through REST. Typing is rate limited to one event per 1.5 s per
  channel per connection.
- Fan-out sends the payload only: the envelope's actor and request meta stay on the server.

### Consequences
The web client (`apps/web/src/lib/ws.ts`) keeps the last seq per topic and re-subscribes + resumes on
reconnect, and `usePresence(workspaceId)` is a React external store over the snapshot and changes. One
in-process presence registry means the Redis bus adapter (Phase 5) must also share presence.

## ADR-0055: The UI system: token names, the unified radix-ui package, cmdk, and `*.ct.tsx` component tests

- Status: accepted
- Date: 2026-09-13
- Task: 0.11

### Context
Spec §4 fixes the visual language (dark-first + light, neutral surface scale + one accent, semantic color
only where listed, 13/14 px sans, mono for code, 6 px radius, hairlines, 120–180 ms motion, reduced motion,
compact/comfortable density) and the component list, but not the CSS variable names, how Tailwind sees
them, which primitives library backs the shadcn base, or how component tests are laid out.

### Decision
- Tokens are `--perch-*` custom properties in `@perch/ui/tokens.css`: surfaces `base | surface | raised |
  overlay`, text `fg | fg-muted | fg-subtle`, `border | border-strong`, one `accent` (+ `accent-fg`,
  `accent-soft`), and the semantic set `danger`, `warning` (permission amber), `success`, `bot`,
  `diff-add`, `diff-remove`, and the seven work item states. Light is the `:root` default, dark comes from
  `prefers-color-scheme` or `data-theme="dark"`, `data-density="compact"` tightens rows and spacing, and
  reduced motion zeroes the motion tokens. The same file carries the Tailwind v4 `@theme inline` mapping,
  so apps use `bg-surface`, `text-fg-muted`, `border-border`, `w-rail`, `min-h-touch`, and so on.
  Apps add `@source "../../../packages/ui/src"` because Tailwind v4 skips linked packages.
- The shadcn base is hand-written on the unified `radix-ui` package (ADR-0023): Button (cva variants),
  IconButton (label required), Input, Textarea, Label, Field (ids for hint/error wiring), Separator,
  Badge/BotBadge, Avatar, Kbd (⌘ on Mac, Ctrl elsewhere), Tooltip, Dialog (center/right/bottom), Sheet.
- Shell components: Shell (rail | sidebar | main | panel + drawer; below 768 px main only with
  MobileTabBar, sidebar and panel as sheets), Rail (tablist with arrow keys, workspace switcher, avatar),
  Sidebar/SidebarSection/SidebarItem, Panel, Drawer (tablist), Peek (right sheet, bottom on phones,
  "Open full"), CommandPalette (cmdk in a Radix dialog, ⌘K hook that yields to a focused editor
  selection), Composer skeleton (Enter sends, Shift+Enter newline, Esc cancels, drafts in localStorage per
  key, toolbar wraps Markdown), EmptyState. Keyboard: ⌘B sidebar, ⌘. panel, ⌘J drawer.
- `useTheme()` persists theme + density in localStorage and applies the attributes; `initTheme()` can run
  before React to avoid a flash.
- Component tests are `src/**/*.ct.tsx` (so `bun test` never loads them), run by
  `bun run ct` → `playwright test -c playwright-ct.config.ts` in packages/ui at 1440 px and a 390 px
  mobile profile, with the harness applying theme/density from `hooksConfig`; every test runs axe and
  expects zero violations. Demo components live in `*.demo.tsx` because CT mounts importable components
  only.

### Consequences
Later components (MessageList, Thread, DiffView, Board, …) extend this package and its CT suite; the
tokens are the only place colors are defined. Fonts are declared (Inter/Geist, JetBrains Mono) but not
bundled yet; the system stack stands in until the fonts ship with the web app.

## ADR-0056: The web shell's URLs, shell state per mode, and committed screenshots

- Status: accepted
- Date: 2026-09-13
- Task: 0.12

### Context
Spec §4 fixes the shell, the six rail tabs, the mobile tab bar (Home, Work, Inbox, Code, More), empty
states, and "widths/state remembered per mode", and says every object has a stable URL, but not the URL
scheme, where user settings live, or what a brand-new user sees before the demo workspace (0.13) exists.
The task asks for 390 px and 1440 px screenshots "in the PR", and this delivery has no PR (ADR-0018).

### Decision
- URLs: `/$workspace/$mode` with the workspace slug and `mode ∈ home | code | work | bots | inbox |
  search`; `/$workspace/settings` for workspace settings; `/settings/profile` and `/settings/security`
  for the account (workspace independent, rendered in the shell with the last workspace); `/welcome`
  to create a (first or another) workspace; `/` redirects to the remembered workspace's Home, the first
  membership, or `/welcome`. Sign-in, sign-up, and invite pages stand alone outside the shell.
- Route data: `_app` checks the session in `beforeLoad` (redirect to `/sign-in?redirect=…`) and
  preloads `me` and the memberships through the query client; `$workspace` resolves the slug once
  (`notFound` otherwise) and passes the workspace down as route context.
- Shell state (sidebar, panel, drawer) is stored in `localStorage` under `perch.shell.<mode>`; mobile
  sheets are transient. The last workspace is stored under `perch.workspace`.
- Mobile "More" is a bottom sheet with Bots, Search, the workspace switcher, Profile, Security,
  Workspace settings, and Sign out. The rail's account button opens the same entries as a dialog.
- Home shows the members with live presence (0.10) until channels arrive; every other mode renders its
  sidebar sections and a one-line empty state that names the phase that fills it.
- The e2e shell spec (`e2e/shell.e2e.ts`) runs axe with the page-level rules on every page and, with
  `E2E_SCREENSHOTS=1`, writes the 1440 px and 390 px screenshots to `docs/screenshots/0.12/`, which are
  committed in place of PR attachments.

### Consequences
Later phases add routes under `/$workspace/<mode>/…` (channels, projects, items) without moving anything;
the demo workspace (0.13) replaces `/welcome` as the first-run landing. Screenshots are regenerated with
the same command when the shell changes.

## ADR-0057: The setup wizard is one POST, gates sign-ups, and confirms PERCH_PUBLIC_URL instead of overriding it

- Status: accepted
- Date: 2026-09-13
- Task: 0.13

### Context
Spec §8 and task 0.13 ask for a setup wizard (admin, workspace, PERCH_PUBLIC_URL, telemetry checkbox) after
`docker compose up`. The spec does not say who may sign up before the admin exists, nor whether the wizard
can change `PERCH_PUBLIC_URL`, which the api reads from the environment and which passkeys (rpID), OAuth
callbacks, and every deep link depend on.

### Decision
- `GET /api/instance` reports `setup_complete` and `telemetry`; the web app redirects every entry point
  (`/`, the shell, sign-in, sign-up) to `/setup` until setup is complete, and `/setup` redirects away
  afterwards.
- `POST /api/setup` (public, once) creates the admin through better-auth's server API (returning the
  session cookie), the admin's Perch profile, the first workspace (owner), the random `instance.id`
  (telemetry.md), `instance.admin_user_id`, `telemetry.enabled`, `instance.public_url`, and
  `setup.completed` in `instance_settings`. A second call is `conflict`.
- Before setup, `POST /api/auth/sign-up/*` answers `forbidden` with `reason: setup_required`, so nobody
  can create an account ahead of the admin.
- The wizard shows the configured `PERCH_PUBLIC_URL` and requires the submitted value to match it (a
  mismatch is a `validation` error carrying the configured value and the hint to change `.env`); it never
  overrides the environment.
- Telemetry is effective when either `PERCH_TELEMETRY` or the wizard's setting is on; the ping itself
  arrives with the telemetry endpoint (docs/telemetry.md).
- Tests and the e2e server complete setup programmatically (`completeSetup`) so every other flow starts
  from a set-up instance; `e2e/00-setup.e2e.ts` drives the wizard through the UI when the server is started
  with `E2E_SETUP=wizard`.

### Consequences
The demo workspace (`PERCH_DEMO_WORKSPACE`, spec §4 first run) can be seeded by the same step later without
changing the endpoint. Instance administration (`/api/admin/*`) keys off `instance.admin_user_id`.

## ADR-0058: Deploy layout: GHCR image names, the runner base scope, the Caddy DNS module, compose-derived DATABASE_URL

- Status: accepted
- Date: 2026-09-13
- Task: 0.13

### Context
Spec §8 names the compose services, the two application images, and the Caddyfile shape, but leaves the
registry names, how the api image gets Node for the Vite build, what "Dockerfile.runner base" contains in
Phase 0, how Caddy gets its DNS-challenge module, and where the Postgres password comes from.

### Decision
- Images: `ghcr.io/12burb/perch-api`, `ghcr.io/12burb/perch-runner`, `ghcr.io/12burb/perch-caddy`, all
  tagged by release (`PERCH_IMAGE_TAG`, which `perch init` pins to the CLI's version; `latest` before the
  first release). Upstream pins resolved from Docker Hub on 2026-09-13: `oven/bun:1.3.11`,
  `node:24.21.0-bookworm-slim` (Node LTS, used only to copy the `node` binary into the Bun build stage
  because Vite runs under Node, ADR-0037), `ubuntu:24.04`, `caddy:2.11.4`, `pgvector/pgvector:0.8.6-pg16`,
  `ollama/ollama:0.34.0`, `cloudflare/cloudflared:2026.9.1`; uv 0.12.13 from PyPI.
- `Dockerfile.api` is two stages: full install + web build, then a slim runtime that copies
  `node_modules` and the TypeScript sources (Bun runs them directly), runs as the image's `bun` user,
  exposes 3000, and takes `api | worker | supervisor` as its command.
- `Dockerfile.runner` (Phase 0) is the base only: Ubuntu 24.04, Bun, Node (tarball verified against
  SHASUMS256), Python + uv, git, ripgrep, tmux, Playwright Chromium, the `perch` user, `/data/homes` and
  `/data/projects`. The runner agent, the pinned OpenCode binary, and the official CLIs are Phase 1
  (tasks 1.1–1.3) and layer on this image.
- `Dockerfile.caddy` builds Caddy with one `caddy-dns` module chosen at build time
  (`CADDY_DNS_MODULE`, default `github.com/caddy-dns/cloudflare`); `perch init` writes the wildcard
  Caddyfile only when a preview domain is given (ADR-0036).
- Compose derives `DATABASE_URL` from `POSTGRES_PASSWORD` (generated by `perch init`) unless `.env`
  sets it; the supervisor is the only service mounting the Docker socket (spec §1.6), asserted by a test.
- The Phase 0 build environment has no Docker daemon, so the images and the "fresh Ubuntu VM" criterion
  are exercised by the compose smoke job in CI (task 0.15), not here.

### Consequences
Renovate tracks the image tags and the version build args. Anyone can `docker build` the three images from
the repo root. A different DNS provider means rebuilding the Caddy image with another module.

## ADR-0059: Laptop mode: RunnerLink, the in-process runner stub, directory backups, and what doctor checks

- Status: accepted
- Date: 2026-09-13
- Task: 0.14

### Context
Spec §2 makes `perch` a single binary running api + web + an in-process runner on PGlite; task 0.14 asks
for `perch dev` with an in-process runner stub, `perch doctor`, and `perch backup|restore`, smoke-tested on
Linux, macOS, and Windows. The §7.6 protocol is a WebSocket; the in-process runner has no socket. The
spec does not define the backup format or the doctor's checks.

### Decision
- `@perch/events` gains `RunnerLink`: a transport-agnostic runner (id, register info, `call(method,
  params)` for api→runner requests, `onNotification` for runner→api methods, `close`). The api keeps a
  `RunnerRegistry` (`deps.runners`; heartbeats, load, sessions, per-workspace lookup) and
  `GET /api/health` reports `checks.runners` and `mode`. Hosted and local runners (tasks 1.2, 1.3) wrap
  their WebSocket in the same interface.
- `@perch/runner` exports `createInProcessRunner()`: registers as a `local` runner named after the host,
  heartbeats, validates every request against §7.6, answers `ports.list` with no ports, and refuses every
  other method with JSON-RPC -32601 and an `arrives` hint until Phase 1 lands the PTY, engines, fs, git,
  and preview pieces. `perch dev` attaches it to the booted api.
- `perch dev` binds 127.0.0.1 by default, uses `~/.perch` (`data/` for PGlite, `files/`, `master.key`),
  derives `PERCH_PUBLIC_URL` from host and port, runs the jobs worker in-process, and stops on
  SIGINT/SIGTERM. `--port 0` picks a free port for smoke tests (with a warning, since the public URL
  then differs).
- Backups are directories: `pglite.tar.gz` from PGlite's `dumpDataDir()` (consistent because PGlite is
  single-process; `perch dev` must be stopped), `files/`, `master.key`, and `manifest.json`
  (`format: perch-backup, version: 1`). `perch restore` loads the tarball through PGlite's
  `loadDataDir` into a fresh directory, verifies it opens, then swaps it in; it refuses a non-empty data
  dir without `--force`. No tar or zip dependency; Postgres deployments use `pg_dump` (docs/deploy.md).
- `perch doctor` checks: Bun ≥ 1.3.11, data dir writable, PGlite opens and migrations are current
  (applying pending ones), master key presence, port availability, the web build, `git` and `docker`
  on PATH; required failures exit 1; `--json` for scripts.
- The laptop smoke test (`apps/cli/test/laptop.test.ts`) spawns `perch dev --port 0`, checks health,
  the instance facts, the setup page, then doctor, backup, and restore; the OS matrix runs it in CI (0.15).

### Consequences
`perch migrate --to-compose` (spec §2) can build on the same backup manifest. The binary build must embed
the web dist and the migrations (text imports already cover the SQL); that is the release workflow's job.

## ADR-0060: The pipeline: what runs where, the budgets, embedded web assets in the binary, and release semantics

- Status: accepted
- Date: 2026-09-13
- Task: 0.15

### Context
Spec §8 lists the CI steps and the release outputs but not how the jobs split, what "perf audit"
measures before task 2.20, how a single `perch` binary serves the web app, what the npm package is
called, or how pre-releases differ.

### Decision
- `ci.yml` splits into `check` (lint, typecheck, unit tests on PGlite and a Postgres service, SDK
  drift), `e2e` (web build, perf budgets, component tests, Playwright from the wizard with axe),
  `laptop-smoke` (Linux, macOS, Windows), and `compose-smoke` (real images, `perch init`, compose, the
  wizard through Caddy, then Trivy). CodeQL is weekly; DCO per pull request; changesets keep a version
  pull request on main.
- Perf budgets (`bun run perf`): initial JS + CSS ≤ 180 KB gzip, total JS ≤ 320 KB gzip, CSS ≤ 48 KB
  gzip, and one WS envelope ≤ 1 KB for representative presence, typing, message, and session-delta
  events. Task 2.20 extends this script.
- The compiled binary embeds the web app: `scripts/embed-web.ts` generates `web-assets.gen.ts` with
  one `with { type: "file" }` import per dist file, the api serves the map with the SPA fallback
  (`AppOptions.webAssets`), and the committed placeholder keeps the map empty so source runs serve
  `apps/web/dist`. The npm package `perch-dev` (bin `perch`) is a Bun-bundled script with `web/` beside
  it; it needs an installed Bun.
- Images are `ghcr.io/<owner>/perch-{api,runner,caddy}`, `linux/amd64` + `linux/arm64`, cosign keyless
  signatures and an attested SPDX SBOM per image. A tag with a pre-release suffix publishes the images
  tagged with that version only (no `latest`, no `major.minor`), marks the GitHub release as a
  pre-release, and publishes npm under `next`.
- Actions are pinned to major tags resolved on 2026-09-13; Renovate pins digests from its first run.
- Docs deploy is deferred to the docs site (Phase 4); `openapi.json` ships as a release asset.

### Consequences
A tagged pre-release exercises the whole release path without touching `latest`. The compose smoke is
the "fresh Ubuntu VM" check for task 0.13.

## ADR-0061: Timestamp parameters go through the column encoders, never as a bare Date in a sql template

- Status: accepted
- Date: 2026-09-14
- Task: 0.6 (found by the task 0.13 compose smoke)

### Context
The first compose smoke booted the api on postgres.js and the jobs worker crashed on its first claim:
`TypeError: The "string" argument must be of type string ... Received an instance of Date` inside
postgres.js's `Bind`. Drizzle's postgres-js driver replaces the postgres.js serializers for the timestamp
types (oids 1082, 1083, 1114, 1184) with identity functions, because drizzle maps Dates to ISO strings
itself in every column encoder. A `Date` interpolated straight into a `` sql`…` `` template has no column
encoder, so it reaches postgres.js as a Date and the transparent serializer hands it to
`Buffer.byteLength`. PGlite's driver serializes Dates on its own, which is why every unit test passed.

### Decision
Timestamp (and every other typed) parameter is bound through a column encoder: the drizzle operators
(`eq`, `lt`, `lte`, `gt`, `gte`, `between`, `inArray`, …) and `.set({ column: value })` do this; inside a
raw template use `sql.param(value, column)`. A bare `Date` in a `` sql`…` `` template is a bug. The jobs
claim query is built from operators, and the `@perch/jobs` suite runs on Postgres as well as PGlite
whenever `PERCH_TEST_DATABASE_URL` is set (the CI `check` job), so the postgres.js binding path is
covered where it differs.

### Consequences
Suites for code that issues queries run on both drivers when they can (the `queueSuite`/`schemaSuite`
pattern); the compose smoke stays the last line of defence for the team-mode wire path.

## ADR-0062: The api image ships a production-only runtime tree on an updated base image

- Status: accepted
- Date: 2026-09-14
- Task: 0.13 (found by the task 0.15 compose smoke)

### Context
The first image that reached Trivy carried the whole monorepo install: Vite's esbuild and the native
TypeScript compiler (Go binaries with dozens of fixed HIGH/CRITICAL CVEs), the spikes' dependencies
including a 180 MB OpenCode binary, and the web and runner dependency trees. The base image was also
behind on Debian security updates (54 fixed findings). The compose smoke gates on Trivy with
`ignore-unfixed` and `CRITICAL,HIGH`, so the image has to be clean rather than the scan relaxed.

### Decision
- The build stage keeps the full install (the web build needs it) and then assembles `/prod`: every
  workspace manifest (the frozen lockfile requires them), `apps/api`, `packages`, `apps/web/dist`, and
  `bun install --frozen-lockfile --ignore-scripts --production --omit=peer --filter @perch/api`. Bun's
  isolated store never prunes in place, which is why the runtime tree is installed fresh instead of
  pruned. `--omit=peer` keeps better-auth's optional `drizzle-kit` peer, and esbuild with it, out; every
  peer the api needs is one of its direct dependencies. `--filter @perch/api` limits the install to the
  api and the workspaces it links (bus, db, events, jobs, policy, vault).
- The runtime stage copies `/prod` as `/app` and runs `apt-get upgrade` before dropping to the `bun` user.
- Spike packages declare their libraries as devDependencies: they are test-only and never belong in a
  production install.

Locally the tree is 151 MB (138 MB of dependencies, 174 store entries, no native binaries) and boots the
api through migrations, the setup wizard, sign-in, and the web app.

### Consequences
A runtime import of anything outside the api's dependency graph fails in the image, which is the
intended signal: a workspace the api starts to import goes into `apps/api/package.json`, and the
filtered install follows it. The Trivy image scan stays a hard gate; base-image findings the Debian
archive has not fixed are excluded by `ignore-unfixed`.

## ADR-0063: The desktop app is laptop mode in the platform webview, driven from Bun

- Status: accepted
- Date: 2026-09-14
- Task: beyond §11 (D.1); asked for after Phase 0

### Context
The spec ships Perch as a web app (a PWA) and a `perch` binary; "desktop" in §11 means the desktop
viewport. The request was desktop software people can open on their machine. The ground rules
constrain the answer: TypeScript end to end and Bun as the runtime, so Electron (a Node main process
and a bundled Chromium) and Tauri (Rust in the repo) are out.

### Decision
- **`apps/desktop`, one binary `perch-desktop`.** It calls `startLaptop()` (extracted from `perch dev`
  into `apps/cli/src/laptop.ts`) in the same process and shows the app in the platform webview through
  `@webviewjs/webview` 0.4.5: an N-API binding to tao and wry (Tauri's windowing and webview crates)
  with prebuilt binaries per platform, Bun support, and a non-blocking event pump, so the in-process
  server keeps serving while the window is open. Rust stays upstream, like bun-pty. `webview-bun`
  (bun:ffi) was the alternative: it blocks the event loop, needs GTK 4 and WebKitGTK 6 on Linux, and
  had no release in over a year.
- **A fixed port, `localhost`.** The window opens `http://localhost:47160` (`--port`). A stable origin
  keeps the session cookie and passkeys across restarts; `localhost` because an IP address is not a
  valid passkey relying party. If a Perch already answers there, the app attaches instead of booting a
  second server; `--url` opens a team instance with no local server.
- **Data beside laptop mode.** `~/.perch` (shared with `perch dev`); the window's cookies, storage, and
  cache in `~/.perch/desktop/webview` through a persistent WebContext (on Windows that is the WebView2
  user data folder, which must never sit beside the executable). Closing the window stops the server.
- **Built per platform.** The addon is installed per platform, so the release workflow builds the app
  on one runner each for Linux x64 and arm64, macOS arm64, and Windows x64: on Windows with the icon,
  product metadata, and no console window (`--windows-*` flags of `bun build --compile`); on macOS as
  an unsigned `Perch.app` bundle zipped with `ditto`. Intel macOS waits for a runner or a signing
  decision. The icon is drawn in `apps/desktop/assets/icon.svg` and rendered by `scripts/make-icons.ts`.
- **Verified where a window can open.** Unit tests cover the flow with fakes; `--check` loads the real
  addon and names the engine version; `--smoke` (a throwaway laptop mode, one window, closed after the
  first page load, every step traced) runs from the test suite in a child process with a hard kill, and
  from the compiled binary behind a watchdog, under xvfb on Linux and natively on macOS and Windows in
  the laptop-smoke job, with `PERCH_DESKTOP_NATIVE=1` so nothing skips in CI. A platform that stalls
  inside its webview blocks that process's event loop, which is why the smoke never runs in-process.

### Consequences
The desktop app is a thin shell: every feature stays in the web app and the api, and the shell has no
IPC surface of its own. Linux needs `libwebkit2gtk-4.1` and `libxdo` installed.

**Windows runs the native loop, with the server in a second process.** The addon's timer-driven
`pumpEvents()` is unreliable on Windows: it calls tao's `run_return`, which leaves its loop only when a
message arrives after the exit flag is set, and the internal paint that carries `MainEventsCleared`
can be starved by other traffic, so a pump can block JavaScript indefinitely (CI showed a blank window
and a frozen thread; a keep-alive `WM_TIMER` did not help). So on Windows `window.ts` calls
`runSync()`, tao's own loop, on the main thread, and `laptop-child.ts` runs laptop mode in a child
process of the same binary (`perch-desktop --serve`, which prints one JSON line when it listens and
stops when its stdin closes, so the server never outlives the window; the parent forwards the child's
output, and when the parent has no standard streams of its own, a console-less binary started by a
click, everything goes to `<data-dir>/desktop/perch-desktop.log`). A Bun worker thread was the
first design and worked from source, but the compiled binary on Windows resolves an embedded worker
entrypoint to a disk path under `B:\~BUN\root` and fails with ENOENT (Linux resolves the same
`file:///$bunfs/...` URL fine); a process of the same executable has no such path. Page events cannot
reach JavaScript while the loop runs, so `--smoke` closes the window from a third process
(`--close-window <hwnd>`, `PostMessageW(WM_CLOSE)` through `bun:ffi`) after 8 s and the test verifies
the page load from the server's request log. macOS and Linux keep the pump and the in-process server
(`PERCH_DESKTOP_SERVER=child` selects the two-process layout anywhere, so the tests cover it on every
platform); the pump path also re-navigates once after 1.5 s when a webview dropped the navigation
requested at creation. The pump behaviour is an upstream (webviewjs/webview) follow-up. Signing and
notarization (macOS), an installer (Windows), tray and auto-start, and an Intel macOS build are follow-ups.

## ADR-0064: No paid plans; every model is the user's own

- Status: accepted
- Date: 2026-09-14
- Task: maintainer direction (2026-09-14), outside the task queue

### Context
The spec describes a self-hosted product with a `workspaces.plan` column (default `self-hosted`, §6) and
three credential lanes for API keys, local models, and vendor subscriptions (§3.6). The maintainer set the
direction explicitly: Perch will not include any paid plans; it is open source, and anyone can connect
their own models to the platform.

### Decision
Perch has no paid plans, tiers, seats, metering, license keys, or hosted upsell, and no feature is gated
on a plan. Models are always the user's own: Lane A, API keys and OpenAI-compatible endpoints (Ollama, LM
Studio, vLLM, llama.cpp, OpenRouter, and any other), vaulted at user or workspace scope; Lane B, vendor
subscriptions inside an endorsed engine, personal and never proxied; Lane C, official CLIs under the
user's own login. `workspaces.plan` stays as a deployment descriptor, `self-hosted` being its only value,
naming how an instance runs and never what it pays for: shipped migrations are never edited (§9.1) and
the column costs nothing. "A paid key" in the Phase 1 exit criterion means a paid provider API key the
user owns, not a Perch plan.

### Consequences
No billing tables, no plan checks in `packages/policy`, no license keys, nothing to unlock. The cost shown
on the Environments page (§3.2) is the user's own provider spend, for their information. A hosted
component, if one ever exists (Perch Link, an optional OAuth broker in the spec's "Later" list), would be
an open-source convenience and never a plan; this ADR is revisited before any such change. The README
states the policy where new users read first.

## ADR-0065: The maintainer's agent sessions push to main directly

- Status: accepted
- Date: 2026-09-14
- Task: maintainer direction (2026-09-14), outside the task queue

### Context
AGENTS.md §2 prescribed a branch and a PR per task. The repository had no base branch until PR #1 created
`main`, and the maintainer, the only committer, directed that changes go straight to `main` from now on.

### Decision
The maintainer's agent sessions commit on `main` and push once the local gate is green (`bun run check`
and the relevant Playwright spec). One task per commit series; the commit body carries the PR template's
content; `TASKS.md` marks `[x]` with the commit rather than a PR link. CI on `main` (`ci.yml`, and
`spikes.yml` when spikes or the lockfile change) is the gate after the fact: a red `main` is fixed forward
before any other work starts. Outside contributors keep the branch-and-PR flow of `CONTRIBUTING.md` with
the DCO check on every pull request.

### Consequences
Task evidence lives in commit messages and `TASKS.md`. A release is cut by running `bun run version`,
committing, and running `release.yml` (a `v*` tag, or a manual run with the version, which creates the
tag), which produces binaries, desktop apps, images, and a GitHub release. `changesets.yml` is a manual
workflow that opens a "Version Packages" pull request for anyone who prefers that flow; it needs the
repository setting that lets Actions open pull requests, which the direct flow does not.

## ADR-0066: The runner control channel: register as a request, per-connection capability secrets

- Status: accepted
- Date: 2026-09-14
- Task: 1.1

### Context
Spec §7.6 fixes the wire: JSON-RPC 2.0 over one WebSocket the runner opens with a connect token,
runner → api notifications, api → runner requests each carrying `workspace_id`, `user_id`, and a
per-request capability token the runner verifies. It leaves open how a runner learns its identity, what
signs the capability tokens, what a connect token is, and how liveness is decided.

### Decision
`runner.register` is a JSON-RPC request (the first message, within 5 s), answered with
`{runner_id, cap_secret, heartbeat_ms}`; every other runner → api message is a notification. The
`cap_secret` is 32 random bytes per connection; capability tokens are HMAC-SHA256 over
`{ws, user, method, exp}` (`packages/events/runner-cap.ts`, Web Crypto only so the same code runs in
the api, the runner, and the browser), minted by the api's `RunnerLink` for each request and good for
60 s; the runner verifies signature, expiry, and claims before dispatching (`-32001` on failure) and, for
local and remote kinds, refuses other users without a grant (`-32003`). A connect token is `prt_` plus
32 random bytes, stored as a sha256 hash in `runner_tokens` with a 30-day default expiry and a
revocation timestamp; the token's runner row fixes the kind, so a registration claiming another kind is
refused. Heartbeats run every 15 s; three missed ones close the socket; a closed socket detaches the
link, marks the row offline, and publishes `runner.offline`. `runner.registered` is published on every
registration (it carries the kind) and `runner.online` only on the offline → online transition. The
runner reconnects with jittered exponential backoff (1 s to 30 s) and gives up after three refused
upgrades so a supervisor sees the exit. The hosted entrypoint (`apps/runner/src/main.ts`) reads
`PERCH_API_URL` and `PERCH_RUNNER_TOKEN`; the runner image builds the agent's production tree the way
the api image does (ADR-0062) and runs it as the entrypoint, so its Docker context is the repository
root. The in-process runner shares the handler table and the capabilities shape and skips the
capability check (one process, no socket).

### Consequences
The registry, the in-process runner, and the socket link all satisfy `RunnerLink`, whose `call` takes
the request without `cap`. Everything a later task adds to a runner is a handler in
`apps/runner/src/handlers.ts` plus its §7.6 schema; the channel needs no change. The runner image is
built only by the release workflow (its Chromium download is too heavy for the compose smoke); a broken
agent build shows up there, not in CI.

## ADR-0067: The supervisor: jobs as the api → supervisor channel, one container per scope, idle by heartbeat

- Status: accepted
- Date: 2026-09-14
- Task: 1.2

### Context
Spec §3.1 gives the supervisor the Docker socket and one runner container per workspace with limits and
idle stop; §8 names the knobs (mode, image, limits, idle minutes). It leaves open how the api asks for a
container from another process, how "idle" is known outside the api, what a shared runner is in the
schema, and where the volumes come from.

### Decision
The api and the supervisor share the database, so the jobs queue (`packages/jobs`) is the channel:
`requestRunner(queue, workspaceId)` enqueues `supervisor.ensure`; the supervisor's worker ensures a
running container for that scope (idempotent, one in-flight ensure per scope). A hosted runner's row
carries `container_id`; a shared runner (`PERCH_RUNNER_MODE=shared`) is a row with a null
`workspace_id`, the meaning the registry already gave workspace-less runners (every workspace may use
it), so `runners.workspace_id` became nullable (migration 0004) and the `runner.*` bus events carry a
nullable workspaceId. Idleness is recorded by the api's channel on every heartbeat: `idle_since` is set
when a heartbeat carries no sessions and cleared when it carries some; the supervisor stops and removes
containers idle past `PERCH_RUNNER_IDLE_MINUTES`, and containers whose runner has been offline that long.
Containers carry `dev.perch.role`, `dev.perch.workspace`, and `dev.perch.runner` labels, a
`RestartPolicy` of unless-stopped, the parsed limits as `NanoCpus`, `Memory`, and `PidsLimit`, the homes
and projects volumes, and the compose network; the volume and network names come from the environment
or, by default, from the supervisor's own container (inspected by hostname), so compose project names
need no configuration. Per-user homes are directories under the shared homes volume
(`/data/homes/<user>`), one volume per instance rather than per user. Runner containers reach the api at
`PERCH_RUNNER_API_URL` (`http://api:3000` in compose). Reconciliation at start removes containers no row
owns and clears rows whose containers are gone. The Docker Engine sits behind a small interface
(`supervisor/docker.ts`): the lifecycle is unit-tested with a fake, and `supervisor.docker.test.ts`
drives the real daemon with a stock image wherever one exists (the CI check job).

### Consequences
Nothing else in the api touches Docker. Anything that needs a runner (sessions, terminals, clones)
calls `requestRunner` and waits for `runner.online`. Idle stop trusts heartbeats: a runner that lies
about sessions stays up. The Docker path is exercised by the CI check job, not by the compose smoke.

## ADR-0068: Local runners: a token from the Environments page, the owner from the api

- Status: accepted
- Date: 2026-09-14
- Task: 1.3

### Context
Spec §3.2: `perch runner connect <workspace>` on a machine you own opens the outbound socket and
registers as one of your environments, serving only you. It does not say how the machine learns which
Perch and which workspace it belongs to, how it proves who it is, or where the Environments page lives.

### Decision
A member registers a machine on the workspace's Environments page ("Connect a machine"): the api
creates a runner row (kind local or remote, `owner_user_id` = the member) and mints its connect token,
returned once inside the full command (`perch runner connect <public url> --token prt_… --name …`).
The workspace is therefore implied by the token, not typed on the command line; the command's first
argument is the api URL. The api's `runner.register` answer carries `owner_user_id`, so the runner
enforces owner-only access from the row rather than from a flag the person could get wrong. Any member
may connect a machine (`runners.connect`); a runner's owner or a workspace admin removes it
(`runners.remove` for others' runners), which deletes the row, cascades its tokens, and closes a live
socket. The Environments page lives with the settings pages (`/<workspace>/environments`, in the settings
sidebar and the command palette) and refetches on every `runner.*` event of the workspace topic, so a
machine shows Online without a reload. The e2e spec drives the real runner agent under Bun with the token
the page minted, at 390 px and 1440 px, and checks the page with axe.

### Consequences
Hosted runners never appear on the connect path (the supervisor mints their tokens). Grants for other
users on a local runner are a later task; until then a local runner refuses them. The `perch` binary
gains a long-running `runner connect` command whose exit code 1 means the api refused the token.


## ADR-0069: Projects: a directory per project on a runner, set up through two additive runner methods

- Status: accepted
- Date: 2026-09-14
- Task: 1.4

### Context
Spec §5.1 lists how a project comes to be (empty, upload, clone over HTTPS with a token or SSH with
a per-workspace deploy key; a project volume in the runner; `.perch/project.json` read and validated;
`devcontainer.json` honored) and §7.1 names the routes (`/api/workspaces/{ws}/projects` + `clone`).
The §7.6 runner protocol has no method that creates a project directory: `git.*` operates on an
existing checkout, `worktree.create` on an existing repository, and `fs.write` takes text. Nothing
says where the directory lives, who runs the clone, how credentials reach git without touching a log
or a command line, or how `key`, status, and the two files map onto the `projects` row.

### Decision
- **Two additive api → runner methods** (a §1.5 deviation, recorded here and in the protocol test's
  additive list): `project.setup` (`source` = empty | upload | clone with optional `auth`) returns the
  checkout facts plus the parsed `.perch/project.json` and `devcontainer.json` (JSONC via `Bun.JSONC`)
  and the `postCreateCommand` outcome; `project.remove` deletes the directory. `fs.write` gains
  `encoding: "utf8" | "base64"` so uploads carry binary files. Everything else (validation, defaults,
  status) stays on the api side, so runners stay dumb and interchangeable.
- **Location**: `<root>/<workspace id>/<project id>`; root `/data/projects` in the runner image (the
  compose `projects` volume the supervisor mirrors into runner containers), `<data dir>/projects` in
  laptop mode and for `perch runner connect`, overridable with `PERCH_PROJECTS_DIR`.
- **Credentials never on argv, never stored**: a token reaches git through a credential helper that
  reads two environment variables; a deploy key is a 0600 temp file handed to `GIT_SSH_COMMAND`
  (`BatchMode=yes`, `IdentitiesOnly=yes`) and deleted after the clone. The runner spawns `git`
  directly with an explicit environment stripped of `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_SSH*`, and
  `GIT_CONFIG_*` (simple-git refuses credential helpers by policy, and inheriting the host's askpass
  would let the host inject a program); error messages have `scheme://user@` scrubbed. The api refuses
  `repo_url`s carrying userinfo on http(s), `file://`, and local paths. Tokens are redacted from logs
  by key (`token`, `privateKey`, `private_key`).
- **The deploy key** is one Ed25519 key per workspace (`deploy_keys` table, migration 0005), minted
  on first read from `node:crypto` and encoded in OpenSSH's own formats in-process (no `ssh-keygen`
  dependency in the api image), private half vault-encrypted with the workspace id as AAD, decrypted
  only for a clone. Members read it; owners and admins rotate it (`deploy_key.read` / `deploy_key.rotate`).
- **Row lifecycle**: `projects` gains `source`, `status` (`pending` → `setting_up` → `ready` | `error`),
  `status_message`, `runner_id`, `head`, `config_error`, `devcontainer`, `created_by`. The row is
  inserted at once (`project.created`); setup runs asynchronously and publishes `project.updated` at
  each step. A valid `.perch/project.json` becomes `config` and sets `default_engine`; an invalid one
  leaves `config = {}` with the reason in `config_error`. A failing `postCreateCommand` is reported in
  `status_message`; the project is still `ready`.
- **Runner choice**: a connected runner the member may use, the workspace's own hosted runner first,
  then the shared or in-process one, then the member's own machines (local runners serve their owner
  only); with none connected the api enqueues `supervisor.ensure` and waits up to two minutes.
- **Policy actions**: `projects.read/create/update` for every role, `projects.delete` for owners and
  admins.
- **Uploads** are multipart parts named `file` whose filename is the path inside the project; no
  archive extraction (a later task can add zip). The client sends `webkitRelativePath` so folders keep
  their structure.
- **Playwright's server is laptop mode**: `scripts/e2e-server.ts` now runs `perch dev`, so specs run
  against the in-process runner exactly as a laptop user does (the acceptance clone of a public
  GitHub repository runs there).

### Consequences
Every deployment kind sets projects up the same way through one runner method; the hosted image's
`devcontainer.json` image/features remain to be honored by the supervisor when per-project images
land. The `project.setup` result is the seed for the editor, terminal, and sessions (1.5–1.8), which
address a project by id and resolve its directory on its runner. The runner-protocol RFC, when it is
written, carries the two methods and the `encoding` field.

## ADR-0070: Runner fs, git, ports, and exec: one policy hook, ripgrep search, direct git for pushes

- Status: accepted
- Date: 2026-09-14
- Task: 1.5

### Context
Spec §7.6 names the methods (`fs.list/read/write/stat/search {query, glob}`, `git.status/diff/
commit/push/branch`, `worktree.create/remove`, `ports.list`, `exec {command, cwd, timeout}
(policy-checked)`) and their notifications (`ports.changed`, `fs.changed`) but not their results,
where worktrees live, how a push gets credentials, what "policy-checked" means before the policy
engine of task 2.11 exists, or how ports are discovered. The acceptance criterion is fs.search under
200 ms on a 50k-file repository.

### Decision
- **One policy hook.** `RunnerPolicy` is a function every fs, git, and exec call consults with a
  typed request (`fs.write {path}`, `exec {command, cwd, root}`, `git.push {branch}`, …). The
  built-in `runnerPolicy(rules)` is the floor (denied command patterns, `.git/**` read-only through
  fs.write, exec confined to the projects root, optional protected branches); `perch runner connect`
  lifts the exec confinement on your own machine (`execAnywhere`). A refusal is `PolicyDenied`
  (JSON-RPC `-32451`, already reserved), which the api maps to 451 `policy_violation`. Task 2.11's
  policy.yaml evaluator plugs into the same hook rather than into each method.
- **Result shapes** are Zod schemas in `packages/events` (`fsListResultSchema`, …,
  `execResultSchema`) so the api validates what a runner answers.
- **Additive params** (spec deviations, all optional): `fs.search {regex, ignoreCase}` (literal and
  smart-case by default, what an editor's search box means), `git.commit {author}` (the api passes
  the member; a hosted runner has no identity of its own), `git.push {auth}` (the deploy key or a
  token, the same shapes as a clone's; a local runner without `auth` uses the machine's own git
  credentials).
- **fs.search is ripgrep** (`rg --json`, `--fixed-strings` unless `regex`, `--smart-case` unless
  `ignoreCase`, `--glob`, a match limit with early kill) when the machine has it, and an in-process
  walk (skipping `.git`, `node_modules`, worktrees, binaries) otherwise; both sort matches by path
  then line. The acceptance benchmark (apps/runner/test/fs.test.ts) builds a 50,000-file tree and
  asserts < 200 ms on ripgrep on Linux, the runner image's platform (~110–140 ms measured in the
  sandbox and in CI's check job). GitHub's macOS VMs walk the same tree in ~650 ms with ripgrep
  (virtualized APFS metadata, not anything in Perch) and Windows runs the built-in engine, so on
  those platforms the test checks correctness and reports the timing instead of asserting the
  budget. CI installs ripgrep on the Linux check job and the Linux/macOS smoke jobs.
- **git through simple-git for reads, commits, branches, and worktrees, spawned directly for
  pushes** (credentials as for clones: helper or key file, never argv). The environment handed to
  git strips the host's askpass/editor/pager/proxy/ssh/config overrides (the list simple-git refuses
  and a few more). Worktrees live beside the project at `<project>.worktrees/<branch>`; `git.diff`
  falls back to the index on an unborn branch; `git.commit` with no `paths` stages everything.
- **exec** runs `sh -c` (`cmd /c` on Windows) with a budget; on Linux under `setsid` so the timeout
  kills the whole process tree, and the output pipes are abandoned on timeout so a lingering
  grandchild cannot hold the call open. Outputs are capped at 1 MiB each.
- **Ports** come from `/proc/net/tcp{,6}` (pids for the runner's own processes via `/proc/*/fd`),
  `lsof -iTCP -sTCP:LISTEN` on macOS, `netstat -ano` on Windows; a 2 s poller emits `ports.changed`
  with the whole list on the first look and on change. The api keeps the list per runner, shows it
  in the Environments payload, answers `GET …/runners/{runner}/ports` live, and publishes
  `preview.port_detected` for each new port on a workspace-scoped runner (task 1.18 consumes it).
- **Notifications from handlers** (`fs.changed` on writes) travel through a small notifier the
  client and the in-process runner fan out; a `fs.watch`-based watcher for edits made outside Perch
  waits for the editor task, where it is needed.

### Consequences
The editor (1.6), terminal path links, the git panel (1.20), and sessions build on these methods
without touching the runner again for the basics. `exec` is the escape hatch for engines and
preflight (§5.6) with a policy floor that cannot be talked away by a prompt. On Windows the search
engine is the built-in walk unless ripgrep is installed; the runner image always has it.

## ADR-0071: The editor: file routes per project, EditorGroup in the ui package, a lezer-based markdown preview

- Status: accepted
- Date: 2026-09-14
- Task: 1.6

### Context
Spec §5.1 asks for a CodeMirror 6 editor (~40 languages, search/replace, multi-cursor, markdown and
image preview) and §4 for an editor group with tabs and breadcrumbs plus a file tree in the Code
sidebar. §7.1's route list has no file routes for a project, §7.6 has the runner methods, and the
spec names no markdown renderer. Every long list must be virtualized, every flow must work at 390 px,
and a README from a cloned repository is untrusted content.

### Decision
- **Routes**: `GET/PUT /api/workspaces/{ws}/projects/{project}/fs/{list,read,stat,write,search}`
  (a §7.1 deviation, additive), each forwarding the matching §7.6 method to the project's runner
  with the member as `user_id`, so a local runner's owner-only rule and the runner's policy hook
  apply unchanged; refusals map through `runnerError` (451 for policy). The api validates paths
  before forwarding. `fs/write` publishes `project.updated {changes: ["files"]}`, which the tree
  listens for.
- **EditorGroup lives in packages/ui** (tabs, breadcrumbs, the tabpanel, keyboard navigation) with
  no CodeMirror dependency; the CodeMirror wrapper, the store, the file tree, and the pane live in
  apps/web, which already pins the CodeMirror packages. A tablist may own nothing but tabs, so the
  per-tab × is a pointer-only affordance outside the accessibility tree; keyboards close with
  Delete / ⌘W on the tab or the labelled Close in the breadcrumb bar.
- **Markdown preview renders from the @lezer/markdown syntax tree into React elements**
  (CommonMark + GFM tables, strikethrough, task lists; raw HTML shown as text; only http(s),
  mailto, anchor, and relative links kept). No HTML string ever reaches the DOM, so no sanitizer
  is needed and no renderer dependency is added; `@lezer/markdown` and `@lezer/common` are pinned
  in apps/web (already installed transitively) and recorded in docs/dependencies.md.
- **Images** preview from the read route's base64 (a data URL); svg, which reads as text, is
  data-URL-encoded the same way. Other binaries explain themselves instead of opening.
- **Open files are a zustand store per project** (buffer, original, dirty = differs, preview
  flag, a line to reveal); tabs are per session. A tab with unsaved changes asks before closing.
- **The file tree is an ARIA tree** (roving tabindex, arrows/Home/End/Enter, lazy directory loads
  through React Query, rows virtualized with TanStack Virtual). On a phone the sidebar sheet closes
  when a file opens. The project-wide search box runs `fs.search` and opens matches at their line.
- **Project routes**: `/{workspace}/code/{project key}` opens a project; the Code sidebar's Projects
  section becomes that project's tree with "All projects" to go back.

### Consequences
Sessions, the terminal's path links, and the git panel address files through the same routes and
store. `fs.changed` from outside edits (agents, terminals) is not yet pushed into open buffers; the
tree refetches on `project.updated`, and a later task wires runner watchers into the editor. Large
files are read-only past 2 MiB.

## ADR-0072: Bundle budgets: the app's own chunks apart from libraries' on-demand packs

- Status: accepted
- Date: 2026-09-14
- Task: 1.6 (follow-up; supersedes the total-JS figure of ADR-0060)

### Context
ADR-0060 set a single "total JS" budget of 320 KB (gzip) over every chunk in `dist/assets` when the
app was an empty shell. The editor (task 1.6) brings CodeMirror's core (loaded with the editor
route) and, through `@codemirror/language-data`, about forty language grammars that the library
imports lazily, one per file type a person opens. Summed, they are ~400 KB a user never downloads
at once, and the old budget failed main.

### Decision
`scripts/perf-budget.ts` reads Vite's manifest (`build.manifest: true`) and splits JavaScript into
two budgets: **app JS** (the entry, everything it imports statically, and every route chunk the app
itself splits off; dynamic imports whose target is app code under `src/`) at 420 KB, and **on-demand
packs** (dynamic imports whose target lives in `node_modules`, i.e. a library's own lazy chunks) at
480 KB. The total is printed as information. Without a manifest (the tests' fixtures) every chunk
counts as the app's. The initial budget (180 KB) and the CSS and WS-envelope budgets stay.

### Consequences
The app budget is what a session actually pays for a route; the packs budget still bounds what the
editor can pull in over time. Either budget is raised only by an ADR that names what grew. The
manifest ships inside `dist` (and the binary's embedded assets); it is a few KB.

## ADR-0073: The terminal: stream sockets, reattachable shells, tmux, and a clean environment

- Status: accepted
- Date: 2026-09-14
- Task: 1.7

### Context
Spec §7.6 puts terminal data on "extra sockets at `/api/runner/stream/{stream_token}`" and gives
`pty.open {cols, rows, cwd, user} → stream token`; §5.1 asks for per-user, tmux-persistent shells
with clickable paths, and the acceptance criterion is that a reload keeps the shell. The spec does
not say how the api pairs a runner's data socket with the browser that asked, how a browser finds
its shell again, or what a shell's environment is.

### Decision
1. **Stream sockets, one hub.** `RunnerLink.openStream(token)` is the api-side contract: the socket
   runner opens `/api/runner/stream/{token}` (its connect token as the bearer, verified like the
   control channel) and a `StreamHub` pairs it with the awaiting caller; the in-process runner pairs
   two in-memory ends. Tokens are single-use and unclaimed ones expire after 15 s
   (`STREAM_OPEN_TIMEOUT_MS`). Frames buffer until the first subscriber on both sides, so scrollback
   sent before a handler attached is not lost. The spec's `pty.data` notification stays unused:
   output has its own socket, and a notification on the control channel would head-of-line-block
   RPCs behind a busy build.
2. **`pty_id` and a grace period.** `pty.open` accepts an optional `pty_id` (additive) and answers
   `{stream_token, pty_id, reattached}`. A shell whose stream closed lives on for `graceMs`
   (10 min) with `scrollbackBytes` (64 KiB) of output replayed to the next stream. The browser keeps
   the `pty_id` per project in session storage, so a reload, a closed drawer, or a dropped socket
   reattaches; "New shell" forgets it. Terminal query sequences (DA, DSR, XTVERSION, DECRQM, kitty
   keyboard, XTGETTCAP, OSC colour queries) are stripped from the scrollback before replay: a
   reattaching xterm would otherwise answer each one into the shell as keystrokes.
3. **tmux.** Where tmux exists the shell is `tmux -u new-session -A -s perch-<sha1(user\ncwd)[:12]>
   -x cols -y rows -c cwd ; set-option status off`: the same person in the same directory gets the
   same session even after the runner process restarts (the tmux server outlives it), and the
   status line is off because the drawer already shows the project and its default colours fail
   contrast in the app's theme. Windows and machines without tmux get `$SHELL -l` / `%COMSPEC%`
   with the grace period only.
4. **Per-user shells and a clean environment.** The shell's environment is the runner's with every
   `PERCH_*` variable blanked (the connect token, the master key, session secrets: AGENTS.md §1.6),
   blanked rather than dropped because the PTY layer (portable-pty under bun-pty) starts from the
   runner's real process environment and merges the given one on top, plus
   `TERM`, `COLORTERM`, `PERCH=1`, `PERCH_USER`, and `HOME=<homes>/<user>` on a hosted runner
   (`/data/homes`, `PERCH_HOMES_DIR`; created 0700 on first use). A person's own variables on a
   local runner stay: it is their machine and their login (lane C).
5. **The browser side.** xterm.js 6 with the fit and web-links addons, loaded on demand
   (`lazy(() => import(...))`) from the project route, so the app JS budget of ADR-0072 rises from
   420 KB to 520 KB for the terminal's chunk while the initial route budget stays. File paths are a
   link provider over the buffer's lines (`path.ext`, `path:line`, `path:line:col`) that opens the
   editor; the drawer is a labelled region with a status line, and closing the drawer does not close
   the shell.

### Consequences
A terminal costs one control RPC and one extra socket per shell; the api relays frames without
parsing them beyond the JSON envelope. Reattach works across api restarts as long as the runner
keeps the shell (the id is the runner's), and across runner restarts on tmux machines. Per-user
homes are a directory per user on the homes volume, as the supervisor mounts it; OS-level user
separation inside the runner image is a later task. The `pty.data` notification remains reserved.

## ADR-0074: Sessions: engines behind one interface, a transcript with a per-session seq

- Status: accepted
- Date: 2026-09-14
- Task: 1.8

### Context
Spec §3.3 gives the Engine interface and the EngineEvent union, §6 the coding_sessions,
session_events, and session_checkpoints tables, §7.1 the session routes, and §7.2 the
`session:<id>` topic; "the api persists every EngineEvent to session_events with monotonic seq and
republishes on session:<id>". It does not say where an engine object lives (adapters run in the
runner, the api drives them), how the api finds the engine for a session, how the person's own
turns are kept, what a session's statuses are, or how seqs are allocated.

### Decision
1. **`packages/engines`** holds the interface as specified, with two additive fields on
   `createSession`: `sessionId` (the api's row id, which engines key their state by, as the runner
   protocol's `session.create` already does) and `mode`. `Engine.id` is a string: the spec's ids
   plus test engines (`fake`).
2. **Registry and hosting.** `EngineRegistry` maps an id to a static engine or to a factory built
   per runner link (memoised per link, so one object holds a session's state). `runnerEngine` is
   the api-side half of every adapter hosted in the runner image or on a local runner: its calls
   map one to one onto §7.6 `session.create/send/permission/cancel`, and `session.event`
   notifications become the round's AsyncIterable. Adapters register with their tasks (1.9–1.11);
   `FakeEngine` (scripted rounds, a pausing permission, cancel → done) serves tests and demos.
3. **The transcript.** `session_events` has the primary key (session_id, seq); `appendEvent` bumps
   `coding_sessions.last_seq` and inserts in one transaction, so seqs are monotonic per session for
   any number of appenders. The person's turn is stored too, as `{type: "turn", text,
   attachments?, mode, userId}`: the spec's union is the engine's side, and a replay without the
   questions is not a transcript (`sessionEventSchema` = EngineEvent ∪ turn; a deviation kept
   additive).
4. **Fan-out.** Every stored event is republished on the bus with the topic `session:<id>`; the
   milestones (created, turn, permission_requested, done, error, and the new `session.status`)
   also carry `ws:<workspace>`. Two bus events are added beyond the spec's list: `session.turn`
   (a 200-character preview; the text is in the replay) and `session.status`.
5. **Lifecycle.** Statuses idle → running → needs_you → running → idle | error, and ended. One
   round per session (409 otherwise). A permission parks the round without a silence timeout;
   otherwise a round that emits nothing for ten minutes is cancelled. `cancel` asks the engine to
   stop and lets its `done` end the round. Engines forget sessions across api restarts, so the
   service re-creates the engine session lazily on the next turn (and after an `unknown_session`).
6. **Schema beyond the spec's columns**: `model_provider`, `model_id` (the ModelRef a session was
   opened with; `model_profile_id` stays for brains), `title`, `turns`, `last_seq`,
   `status_message`. The default model is `{provider: "engine", modelId: "default"}` — whatever
   the engine is configured with — until model profiles (task 1.15) choose.
7. **Policy**: `sessions.read`, `sessions.create`, `sessions.update` for every member (write
   scope for tokens); `session:<id>` WS topics need a membership in the session's workspace.

### Consequences
The api never talks to an agent runtime directly: a runner-hosted engine is one `runnerEngine`
per runner link, and the same session service drives the fake in tests. Replay and live updates
share one seq, so a client resumes from `last_seq` with no gaps. Checkpoints, diffs per turn, and
sharing (the remaining `/api/sessions/{s}` routes) come with their tasks on the same tables.

## ADR-0075: The ACP adapter: one client on every runner, agents chosen by the model's provider

- Status: accepted
- Date: 2026-09-14
- Task: 1.9

### Context
ADR-0013 makes the Agent Client Protocol the engine contract and ADR-0030 verified the SDK on Bun
against a stub agent. Spec §7.6 gives `session.create {project, engine, model, mode, worktree,
env}` and `session.event` notifications, but not how a session names its agent, how ACP's updates
map onto the EngineEvent union, what happens to thoughts and plans, or where the agents' launch
commands come from. Gemini CLI and Codex, the acceptance agents, need vendor credentials this
environment does not have.

### Decision
1. **Where.** The adapter runs in the runner (apps/runner/src/acp.ts, sessions.ts): the api's
   `acp` engine is the `runnerEngine` bridge of ADR-0074, one per runner link, so hosted, local,
   and in-process runners all host agents the same way, next to the project.
2. **Which agent.** `model.provider` names the agent (`gemini`, `codex`, `claude`, `goose`,
   `opencode`, `qwen`, `cline`, or an id from `PERCH_ACP_AGENTS`); `engine`/`default` means the
   runner's `PERCH_ACP_AGENT` (default `gemini`). The built-in table mirrors the ACP registry as of
   2026-09-14 with its pinned versions (`@google/gemini-cli@0.59.0 --acp`,
   `@agentclientprotocol/codex-acp@1.11.0`, `@agentclientprotocol/claude-agent-acp@0.77.0`,
   `goose acp`, `opencode acp`, `@qwen-code/qwen-code@0.23.3 --acp --experimental-skills`,
   `cline@3.0.61 --acp`); a binary on PATH wins, npx is the fallback, and neither is a clear error
   at the first turn. Registry updates are ordinary dependency bumps of the table.
3. **Mapping.** Text chunks → `text`; `tool_call` → `tool_call` with the title as the name and
   `rawInput` as args; a completed or failed `tool_call_update` → one `tool_result` whose `diff`
   comes from `diff` content blocks rendered as unified patches (apps/runner/src/diff.ts, no
   dependency); `request_permission` → `permission` with ids `p1, p2, …` per session, answered by
   `session.permission` with the agent's closest option kind; `PromptResponse.usage` (cumulative in
   ACP) → per-round `usage` by difference, cost from `usage_update` when in USD; `end_turn` and
   `cancelled` → `done`, `refusal` → `error`. Thoughts, plans, and user-message echoes are dropped
   until the EngineEvent union has a place for them. The transcript keeps the agent's order: a
   permission request yields to the update queue before it is emitted.
4. **Modes.** Perch's `plan`/`build` are mapped onto the agent's `availableModes` (an id or name
   containing "plan"; otherwise a build-like id, else the first non-plan mode) through
   `session/set_mode`; agents without modes ignore it.
5. **The client capabilities.** `fs/read_text_file` and `fs/write_text_file` are served inside the
   session's directory (the project or its worktree) through the runner's policy hook, writes
   announcing `fs.changed`; terminals are declared unsupported for now. MCP servers ride the
   `session/new` request; Perch's own tools attach once the MCP gateway (task 1.17) exists.
6. **Environment and lifetime.** The agent inherits the terminal's environment (ADR-0073: PERCH_*
   blanked, HOME per person) plus the session's `env`; its stderr is logged; a session idle for
   thirty minutes is closed and re-created on the next turn. `session.send` answers `{started}` at
   once; a round's events are notifications, so long turns never hit the request timeout.
7. **Acceptance.** CI drives the whole flow against a registry-shaped agent built on the SDK
   (apps/runner/test/fixtures/acp-agent.ts): two turns, one permission prompt, the edit through the
   fs capability with its diff, modes, cancel, deny, a failing prompt. The same test runs against
   Gemini CLI or Codex with `PERCH_ACP_TEST_AGENT` and the vendor's credentials; CI has none, so
   that run is a documented command rather than a job.

### Consequences
A new registry agent is a table entry, not an adapter. The api never sees agent binaries or
credentials; a local runner runs its owner's agents under their own login (lane C). Per-turn usage
is only as good as what the agent reports, and cost only when the agent reports USD. The runner
protocol gains a result shape for `session.create` (additive).

## ADR-0076: The OpenCode adapter: a server per project, the session diff as the turn's diff

- Status: accepted
- Date: 2026-09-14
- Task: 1.10

### Context
Spec §3.3 keeps OpenCode as a second engine for its extras beyond ACP: `opencode serve` per
project, the SDK client, plan/build agents, subagents, native provider credentials. ADR-0031
verified the SDK and the pinned 1.18.30 binary on Bun. The spec does not say how OpenCode's event
stream maps onto EngineEvents, where a turn's diff comes from, how the server is started with the
project's environment, or how the adapter is tested without a model key.

### Decision
1. **A server per project directory**, started on first use with the project's environment
   (`shellEnv` of ADR-0073 plus the session's `env`) and `OPENCODE_CONFIG_CONTENT`
   `{autoupdate: false, share: "disabled"}`, on a free loopback port; the runner spawns the binary
   itself (the SDK's helper cannot set a cwd or environment) and waits for the same "listening"
   line the SDK waits for. Servers with no session left are stopped after the idle period. The
   pinned binary is installed in the runner image through `opencode-ai@1.18.30` (npm's postinstall
   fetches the platform build); a local runner uses `opencode` on PATH.
2. **A Perch session is an OpenCode session** on that server; a turn is `session/prompt` with the
   text, `agent: build | plan` from Perch's mode, and `model: {providerID, modelID}` when the
   session names one (`engine`/`default` leaves OpenCode's configured model). `session/abort`
   cancels; an aborted assistant message ends the round with `done`.
3. **Mapping.** Text parts → `text` (the SDK's delta, else the part's new tail); tool parts →
   `tool_call` at first sight and one `tool_result` at completed/error, with the edit and write
   tools' `filediff` (plus their unified `diff` when present) as the FileDiff; `permission.updated`
   → `permission` (title as the tool name; type, pattern, and metadata as args), answered with
   `once`/`always`/`reject`; the assistant message's `tokens` and `cost` (or the summed step-finish
   parts) → `usage`; `session.error` and the message's `error` → `error`. Reasoning parts and
   `user_message` echoes are dropped, like the ACP adapter's thoughts.
4. **The turn's diff.** OpenCode's session diff is cumulative; after a turn the adapter fetches it
   and reports, as one `diff` tool call and result, the files no tool reported this turn whose
   content moved since they were last reported. That is how subagents' and unreported edits reach
   the transcript, and how the acceptance ("a session edits a file and the diff arrives as
   EngineEvents") holds for every path an edit can take.
5. **Subagents.** Child sessions (OpenCode's `parentID`) are tracked so their permission requests
   are surfaced and answerable; their text stays inside the parent's `task` tool part as OpenCode
   presents it.
6. **Tests.** A stand-in server (apps/runner/test/fixtures/opencode-server.ts) speaks the SDK's
   endpoints and SSE stream, so CI covers the mapping, the diffs, modes, permissions, abort, and
   errors without a model key; the real binary path (`serve`, a session, a keyless prompt failing
   cleanly) runs where `opencode` is installed, as spike 0.4.3 does.

### Consequences
One OpenCode process per project on a runner, shared by that project's sessions. Provider
credentials for the server come from OpenCode's own configuration on the runner until brains (task
1.15) inject them per session through the gateway. The adapter is the only code touching OpenCode's
API (`/session`, `/session/{id}/message`, `/session/{id}/permissions/{id}`, `/session/{id}/abort`,
`/session/{id}/diff`, `/event`); an SDK bump reruns the spike first.

## ADR-0077: The cli-harness lane: a process per turn, resumed by the CLI's own session, local only

- Status: accepted
- Date: 2026-09-14
- Task: 1.11

### Context
Spec §3.3 keeps a `cli-harness` engine behind a feature flag, off by default: the official CLIs in
headless mode under the person's own login (Codex `exec --json`, Claude Code `-p --output-format
stream-json`, Gemini CLI), personal scope only; §3.6 lane C says Perch is a terminal here, not a
harness, and that Claude Code on this lane stays off until Anthropic's terms are confirmed. No
feature-flag facility existed yet, the CLIs' JSONL formats are documented but not recorded here
(no logins in this environment), and hosted runners run under a shared container account.

### Decision
1. **Flags** (spec §9.1): `apps/api/src/flags.ts` declares every flag with the release it appeared
   in; `isOn(name)` reads the `flags` instance setting (an admin's JSON object, wins when it names
   the flag) and otherwise `PERCH_FLAGS` (the operator's comma-separated list). A session on
   `cli-harness` is refused with 422 and `details.flag` while `cli_harness` is off.
2. **Local only.** The runner allows the engine only when it was connected by its owner (`perch
   runner connect`, kind local or remote) or is the in-process laptop runner; a hosted runner
   refuses it. The CLI runs with the person's own HOME, so their own login and subscription apply
   and nothing is proxied.
3. **A process per turn.** Each turn spawns the CLI in the project directory with its documented
   headless flags; the CLI's own thread or session id, taken from the stream, resumes the next
   turn (`codex exec … resume <id>`, `claude -p --resume <id>`). Perch's `plan` maps onto Codex's
   read-only sandbox and Claude Code's `plan` permission mode; `build` onto `workspace-write` and
   `acceptEdits`. Cancel ends the process (SIGTERM, then SIGKILL).
4. **Mapping.** Codex: `agent_message` → text, `command_execution` → shell tool call and result
   with the exit code, `file_change` → an `apply_patch` call and the changed paths,
   `mcp_tool_call` and `web_search` → tool call and result, `turn.completed` → usage and done,
   `turn.failed`/`error` → error; reasoning is dropped. Claude Code: assistant text → text,
   `tool_use` → tool call (an `Edit` or `Write` yields the FileDiff from its own input, emitted with
   the call), user `tool_result` → tool result, `result` → usage with `total_cost_usd` and done or
   error. Unknown event types are ignored, so newer CLI versions degrade to fewer events rather
   than failures. No permission prompts: the CLIs apply their own approval policies.
5. **Gemini CLI** is not on this lane for now: it is already an engine through ACP (ADR-0075),
   and its stream-json format is not recorded here.
6. **Tests.** Stand-ins print the documented streams (apps/runner/test/fixtures/fake-codex.ts,
   fake-claude.ts) and record their argv, so CI checks the flags the harness passes and the
   mapping; the real-CLI acceptance runs on a machine with the logins.

### Consequences
The lane costs nothing when off. Its formats follow the CLIs' documentation at the time of
writing; a format change shows up as missing events, corrected by a parser edit. Claude Code stays
selectable only where the flag is on, and the spec's terms caveat is documented rather than
enforced in code beyond the flag.

## ADR-0078: The session pane: the panel, a reducer over the replay, and a fork that copies the transcript

- Status: accepted
- Date: 2026-09-14
- Task: 1.12

### Context
Spec §4 puts the agent session in the panel of Code mode and lists SessionTranscript, ToolCard, and
PermissionPrompt among the ui components; §5.1 names the pane's parts; §7.2 streams
`session.delta` events on `session:<id>`. The bus payloads of ADR-0074 carry ids and previews, not
the full events, and the spec's route list has neither rename nor fork.

### Decision
1. **Where.** A session is selected by `?session=<id>` on the project route and rendered in the
   panel through the shell's `setPanel` (the editor stays in main; a phone pushes the pane over
   it). The sidebar's Sessions section lists the open project's sessions and starts new ones with
   an engine (default `acp`) and an optional agent/provider.
2. **Transcript.** `packages/ui` gets `SessionTranscript` (a virtualized `role="log"` live region
   of turns, replies, tool cards, permission prompts, errors), `ToolCard` (one line until opened;
   arguments, output, and per-file diffs with +/- counts), and `PermissionPrompt` (the three
   answers of §5.1). The app folds session events into those items with a pure reducer
   (apps/web/src/code/transcript.ts): consecutive text deltas into one reply, a tool call and its
   result into one card, a permission and its answer (from `session.permission_answered`) into one
   prompt; usage events sum into the footer.
3. **Live updates.** The pane replays `GET /events` from seq 0, subscribes to `session:<id>`, and
   applies `session.delta` payloads inline when their seq is the next one; any other event (or a
   gap) fetches what is new after the last seq. Status changes invalidate the session query.
4. **Rename and fork** are additive routes: `PATCH /api/sessions/{s} {title}` and
   `POST /api/sessions/{s}/fork`. A fork is a new session on the same project, engine, model, and
   mode with the transcript so far copied (same seqs, `last_seq` carried over) and
   `forked_from_id` set (migration 0007); the engine's own memory starts fresh on the fork until
   adapters fork natively (ACP `session/fork`, OpenCode's fork), which the transcript copy already
   presents correctly.
5. **Tests.** The Playwright spec drives plan → build → permission → done on the runner tests'
   fake ACP agent, which `scripts/e2e-server.ts` registers as the laptop runner's default agent
   through `PERCH_ACP_AGENTS`; so the flow needs no model key in CI.
6. **Budget.** The transcript pieces ship from their own entry point, `@perch/ui/session`, not the
   `@perch/ui` barrel: a module the barrel reaches and any lazy route uses lands in the initial
   chunk (Rolldown assigns it to the entry that can reach it), and the transcript brings the
   virtualizer along. Likewise the route validates `?session=` with a four-line function rather
   than a Zod schema, because `validateSearch` stays in the eagerly loaded route config and Zod
   is 20 KB gzipped; the API keeps validating with Zod. Both keep the initial payload under the
   180 KB of ADR-0072.

### Consequences
The pane is one component over the replay endpoint and one topic, so a reload or a second tab
converges on the same transcript. Per-turn diffs and checkpoints (later tasks) have the tool cards'
diffs and the fork's transcript copy to build on.

## ADR-0079: Checkpoints as parentless commits, diffs as ranges, and a reject that reverse-applies

- Status: accepted
- Date: 2026-09-14
- Task: 1.13

### Context
Spec §4 asks for per-turn and cumulative diffs, hunk-level accept/reject, file-level Accept all /
Reject all, Restore checkpoint per turn, and Apply on code blocks; §6 has `session_checkpoints
(session_id, turn, git_ref)`; §7.1 lists `diff?turn`, `diff/apply`, and `checkpoints/{turn}/restore`
on a session; §7.6 has `session.checkpoint` and `session.restore` on a runner. Nothing said what a
checkpoint *is*, and an agent's working tree is mostly untracked files on a branch the person also
uses.

### Decision
1. **A checkpoint is a snapshot, not a commit on a branch.** Before every turn the runner writes
   the working tree to a scratch index (`git add -A` with `GIT_INDEX_FILE` pointing at a temp
   file), writes that tree, and commits it parentless under
   `refs/perch/checkpoints/<session>/<turn>`. HEAD, the branch, the person's index and their
   staged work are never touched, and untracked files are captured while ignored files are not.
   Every command in this lane runs with line-ending conversion off (`core.autocrlf=false`,
   `core.eol=lf`): a checkpoint is the bytes that were there and a restore puts those bytes back,
   where the Git for Windows defaults would have rewritten every LF file as CRLF on the way out.
   Taking one is best effort: a project that is not a git repository still takes turns.
2. **A diff is a range.** `git.diff` keeps its old meaning with no `ref` (the working tree against
   HEAD, tracked files only) and gains two: with `ref`, that ref against the tree as it is now
   (snapshotted the same way, so new files appear); with `ref` and `to`, one ref against another.
   A turn's diff is its checkpoint to the next turn's (or to now, for the last turn); the
   session's diff is the first checkpoint to now. `git.diff` also answers `patches`: the same diff
   split into one `FileDiff` per file, hunks intact, by the pure helpers in
   `@perch/events/diff` (`splitPatches`, `parseHunks`, `selectHunks`).
3. **Accept is a decision, reject is an edit.** The agent's changes are already in the working
   tree, so accepting a hunk records a review decision in the pane and writes nothing. Rejecting
   selects that hunk out of its file's patch and sends it to the runner's additive `git.apply`
   with `--reverse`, so only those lines go back. Rejects in one request travel as one patch:
   all land or none. Each decision carries the `@@` header the client saw; a mismatch is a 409
   ("the diff changed; reload it") rather than a patch applied to the wrong lines.
4. **Restore rewrites only what differs.** `session.restore` diffs the checkpoint against the tree
   now, checks the changed paths out of the checkpoint through a scratch index, deletes the ones
   that did not exist then, and leaves everything else (ignored files, the index, HEAD) alone.
   Every path it would write goes through the policy's `fs.write` rules first, as `git.apply` does,
   so `.git` stays out of reach. The restore is recorded in the transcript as an additive `restore`
   session event, so a replay shows where the project was put back.
5. **Apply on code blocks** parses the fences out of a reply in the ui
   (`splitCodeBlocks`); a fence may name its file (```` ```ts path=src/a.ts ````, `ts:src/a.ts`,
   `title="src/a.ts"`), and Apply writes the block to that file through the existing
   `fs.write` route, falling back to the open editor tab when the fence names none.
6. **A fork inherits its checkpoints.** A fork copies the transcript (ADR-0078), so it copies the
   turn counter and the `session_checkpoints` rows with it: the turns a reader sees are the turns
   Restore refers to, and the fork's next turn is N+1, not 1 again. The commits are in the same
   project, so the rows are valid as they stand — but they were written under the *source*
   session's ref, so `session.restore` takes the checkpoint's commit from the api (additively,
   beside `turn`) and only falls back to resolving this session's own ref.
7. **Budget.** `DiffView` ships from its own entry point, `@perch/ui/diff`, and the diff helpers
   from `@perch/events/diff` — importing them from the `@perch/events` barrel pulled Zod and every
   schema into the web bundle (+29 KB gzipped on the Code route), the same trap ADR-0078 hit.

### Consequences
Review is honest about where the bytes are: the tree is the truth, the diff is computed from it
every time, and the pane never holds a patch the runner has not agreed with. Worktrees per task
(§5.7) and Race mode get a snapshot primitive that does not fight the person's branch. What is not
here: an accepted hunk is not remembered across a reload (it is a decision about a diff that no
longer exists once the next turn runs), and a rejected hunk that the agent re-makes next turn shows
up again.

## ADR-0080: ⌘K inline edit: a hidden session per person and project, and a proposal the editor owns

- Status: accepted
- Date: 2026-09-14
- Task: 1.14

### Context
Spec §4 puts ⌘K on a selection in the editor ("inline edit on a selection with the diff in place")
and says ⌘K is the command palette everywhere else. §7.1 has no route for it, and §6 has no place
to put the conversation it needs. An agent that edits the file directly would be the wrong shape:
the person has an unsaved buffer open, and the point of ⌘K is to see the change before it lands.

### Decision
1. **A route that writes nothing.** `POST /api/workspaces/{ws}/projects/{p}/inline-edit`
   `{path, selection, instruction, language?}` → `{replacement, session_id}` (additive to §7.1).
   The api asks the agent for the replacement and hands it back; nothing touches the project. The
   editor puts it in the buffer and ⌘S writes it, as with any other edit.
2. **The lane is a session, and it is hidden.** The turns are a real conversation, so they belong
   in `coding_sessions` — but not in the list of sessions a person browses. `kind` (migration 0008,
   `agent` by default) marks the editor's lane; the list filters it out, one is reused per person
   and project, and its bus events stay on `session:<id>` instead of the workspace topic, because
   its turns carry whatever the person had selected.
3. **The engine comes from the runner.** ⌘K has no engine picker, so the lane opens on the
   project's default engine when the project's runner reports it, and otherwise on one the runner
   does report. A laptop without OpenCode installed still gets ⌘K.
4. **A permission mid-round is refused.** Nobody is watching an inline round, and the edit belongs
   in the buffer, so the api answers `deny` and lets the agent finish. An empty reply is not an
   error: the editor says the agent had nothing to put there.
5. **The diff is in the document.** The proposal replaces the selection in the buffer, the new text
   is marked, and the replaced text sits struck through above it as a block widget until Accept
   (which keeps the buffer) or Reject (which puts the original back). A tab switch drops an
   unanswered proposal, because its range means nothing in another document.
6. **⌘K ownership is per event, not per state.** CodeMirror draws its own selection, so the native
   DOM selection is collapsed and the shell cannot tell whether the editor has one. The editor sees
   the keydown first and claims that exact event; the palette's window listener stands down for it.
7. **One code-block parser.** Reading the replacement out of a reply is the same work as rendering
   a reply's blocks, so the parser moved to `@perch/events/code-blocks` (pure, no schemas) and both
   the ui and the api use it.

### Consequences
⌘K costs one round on a session the person already owns, and the transcript of that session is an
honest record of what was asked. The file only changes when the person saves, so a bad proposal
costs nothing. What is not here: streaming the proposal as it arrives, edits that span files, and a
model picker for the lane — all of which want the brains of task 1.15 first.

## ADR-0081: Brains: a live catalog from each provider, a vault-backed credential, and env into the engine

- Status: accepted
- Date: 2026-09-15
- Task: 1.15

### Context
§11 task 1.15 asks for a model catalog "seeded from models.dev". models.dev is not reachable from
the build environment here (the egress proxy refuses the CONNECT), so seeding from it would mean
guessing the shape of a file I cannot read, committing that guess, and shipping a table that is
stale the day a provider adds a model. §3.4 also says Perch runs engines on *native* provider
credentials rather than proxying them, so a brain has to end up as environment on the engine's
process, not as a gateway route.

### Decision
1. **The catalog is the provider's own listing.** Every provider Perch lists models for answers the
   OpenAI-compatible `GET {base}/models`, so `packages/gateway/catalog.ts` asks the credential's own
   endpoint and shows what comes back. One code path covers OpenAI, an aggregator, and a laptop
   running Ollama, and the list can never go stale. Providers whose list is not that shape
   (Anthropic, Google) are marked `lists: false` and the model id is typed instead of picked.
   A deviation from §11's "seeded from models.dev", recorded here.
2. **Listing is the test button.** A provider that answers with its catalog is a provider that took
   the credential, so "Test" is the same call. 401 or 403 marks the credential `invalid`; anything
   else leaves the row alone, because a network that is down is not a key that is wrong.
3. **`custom` is a provider.** An OpenAI-compatible base URL the person types covers LM Studio,
   vLLM, llama.cpp, a proxy, and whatever ships next, so a new provider does not need a release.
   Every credential may override its provider's base URL, which is what makes that work.
4. **Scope is user or workspace.** Your own key is yours to add (`brains.write`); one the whole
   workspace runs on is an admin's (`brains.admin`), and so is removing one. A user-scoped
   credential is invisible to everyone else, in the list and in `engineEnv`, which keeps AGENTS.md
   §1.6's "personal credentials are user-scoped and never proxied".
5. **A brain is a name over (provider, model, credential).** `model_profiles` carries the name
   people pick from, and one profile per workspace may be the default for `chat` or for `code`
   (a partial unique index enforces it). A profile with no credential runs on whatever the engine
   is already logged in as — §3.6 lanes B and C — which is how a Claude Code or Codex subscription
   keeps working without a key.
6. **The secret goes to the engine as environment, and nowhere else.** `BrainsService.engineEnv`
   is the single place a plaintext key leaves the vault: it becomes `OPENAI_API_KEY` (or the
   provider's own variable) plus a base URL on `session.create {env}`. No route, transcript, event,
   or log line carries a key; the API answers with a hint like `sk…4f2a`, which is enough to tell
   two keys apart and useless to anyone who reads it.
7. **Ollama is detected, not configured.** On the providers call Perch asks `PERCH_OLLAMA_URL` and
   then `http://127.0.0.1:11434/v1` with a 1.5 s timeout; if one answers, the settings page offers
   to add it in a click. A laptop with Ollama running is one button away from a working brain.
8. **The program the engine runs gets its own field.** Until now `model.provider` doubled as the
   ACP agent id and the cli-harness CLI id, because nothing else named them ("gemini", "codex").
   A brain's provider names a *model* provider ("openai", "ollama"), so the two meanings had to
   part: `session.create` gains `agent` (additive to §7.6), `POST .../sessions` gains `agent`
   (additive to §7.1), and `coding_sessions.agent` remembers it across a reopen and a fork. A
   session that names no agent runs the runner's default agent; cli-harness, where the CLI *is*
   the choice, asks for the name unless the runner has exactly one. A wrong agent is an error
   again rather than a silent fall back to the default, which is what `model.provider` would now
   cause. ⌘K inherits the workspace's default brain for free, which ADR-0080 left for this task.

### Consequences
A workspace can run on a cloud key, on a laptop's Ollama, and on an engine's own subscription at
once, and switching is a dropdown in the new-session form. The cost of the live catalog is a
round-trip per credential (cached by TanStack Query) and a model picker that is empty until the
credential is tested — acceptable, because the alternative was a wrong list. What is not here:
per-brain parameters and tool policy (the columns exist, nothing reads them yet), cost caps, and
the `chat` default, which waits for chat sessions in Phase 2.

## ADR-0082: Connections v1: manifests, a minted token per call, and no JWT dependency

- Status: accepted
- Date: 2026-09-15
- Task: 1.16

### Context
§3.5 names four registration lanes and says the paste lane is always available. It also says
GitHub's remote MCP has no DCR, so GitHub means a GitHub App or a fine-grained PAT. What it does
not say is where the knowledge of a provider lives, what Perch stores for an app, or what happens
to a token between the vault and the provider — and those are the decisions that make or break the
§1.6 invariant.

### Decision
1. **A provider is a manifest, not code.** `connectors/<id>/manifest.yaml` carries the lanes, the
   API base, the token prefixes, the call that proves a connection works, and the OAuth endpoints.
   Adding a service is a YAML file. The manifests are imported as text so a compiled `perch` binary
   carries them, the way `packages/db` carries its migrations.
2. **The paste lane is appended to any manifest that forgot it**, because §3.5 says it is always
   available and a manifest should not be able to take it away by omission.
3. **An app stores only its private key.** A GitHub App connection keeps the app id and the PEM;
   every installation token is minted for one call and never persisted. So the blast radius of the
   database is "an app that must be rotated", not "tokens that work until they expire".
4. **`tokenFor` is the single door.** Every lane resolves through one method: a pasted token as it
   was pasted, an OAuth access token out of its pair, an installation token minted on the spot.
   Everything that calls a provider goes through it, so there is one place to audit.
5. **No JWT library.** The app JWT is RS256, which Bun's WebCrypto signs natively; the only awkward
   part is that GitHub issues PKCS#1 keys and WebCrypto imports PKCS#8, which is a fixed header to
   wrap. Sixty lines and no dependency to keep current beats a dependency for sixty lines.
6. **Authorizations in flight live in memory for ten minutes.** State and PKCE verifier are held in
   a map, swept on use, and single-use — a replayed callback finds nothing. They do not survive an
   api restart, which is the same trade §3.1 makes for presence and rate limits: an authorization
   nobody is waiting on any more is not worth a table.
7. **A clone and a pull request both take a connection.** `auth: {kind: "connection"}` on a clone,
   and a pull-request route that pushes and opens in one round. Both mint the token for that round
   and drop it; the runner sees a token, never a connection.
8. **The callback answers with a redirect, not an error page.** A provider that refuses, or a state
   Perch is not waiting for, lands the person back on the Connections page with the reason in the
   query — a stack trace on a URL somebody was redirected to is nobody's idea of a good time.

### Consequences
GitHub works end to end: clone, push, open a pull request, all on a credential that exists for
seconds. A second connector is a YAML file plus whatever its API shape needs. What is not here:
MCP OAuth with DCR, refresh jobs for expiring tokens, the grants UI, and every connector but GitHub
— all of which are task 2.14, with the MCP gateway itself at 1.17.

### What could not be verified here
`docs.github.com` answers 403 CONNECT through this build environment's egress proxy, and the proxy
refuses the `/app/*` GitHub API paths outright. The App lane's request and response shapes are
therefore implemented from knowledge and exercised only against a stand-in that matches them; they
have not been checked against GitHub or its documentation. Worse, the proxy answers
`GET https://api.github.com/user` with 200 for *any* bearer token, so nothing in this environment
can observe GitHub refusing a credential — which is why the end-to-end spec depends on no provider
at all and the provider interaction is covered against a stand-in instead. Whoever has a real
GitHub App should confirm the installation-token exchange before this is relied on.

## ADR-0083: The MCP gateway is a proxy that reads its own traffic

- Status: accepted
- Date: 2026-09-15
- Task: 1.17

### Context
§7.5 says Perch exposes each connection as a Streamable HTTP MCP server at `/mcp/{connectionId}`,
that tools are filtered by a grant's `allowed_tools`, that every call is audited, and that the
upstream carries the delegated token and never the caller's bearer. §3.5 adds the other half: the
downstream consumers — OpenCode and ACP sessions "via injected MCP config", native bots, the Bot
API — never see raw tokens. Nothing in the spec says how a session comes to have a grant, what it
authenticates to the gateway with, or how a self-hosted provider is reached.

### Decision
1. **The gateway speaks MCP on both sides.** A client upstream carrying the connection's token, a
   server downstream carrying nothing. A transparent byte proxy would be smaller, but it could not
   filter a tool list or audit a call — and §7.5 asks for both. So the traffic is parsed, and
   `tools/list` and `tools/call` are the two methods the gateway actually implements.
2. **Stateless per request.** Each request builds its own `Server` and transport and closes them.
   A proxy in front of somebody else's server cannot honestly promise session continuity it does
   not control, and a skeleton can afford one upstream connection per request.
3. **A session authenticates with a token of Perch's own.** An HMAC over `{ws, user, session, exp}`
   with the api's session secret, twelve hours, minted when the session is created and handed to
   the runner in the ACP `mcpServers` config. It is not a bearer the caller brought: §7.5 forbids
   forwarding one upstream, and this way there is nothing to forward. A leaked gateway token is
   good for one session's connections and expires on its own.
4. **A new session is granted its own owner's personal connections, and nothing else.** A person
   acting through their own agent is on-behalf-of by definition, so `connection_grants` gets a
   `session` row per personal connection at session create (and at fork), with `obo` true and no
   allow-list. A **workspace** connection is not auto-granted — §3.5 wants those granted explicitly
   — so it stays invisible to a session until the grants UI of task 2.14. Nothing here narrows a
   tool list; a grant's `allowed_tools` does, and the gateway honours one the moment it is written.
5. **No grant, no tools — not a broken turn.** A session whose grants or provider are unreachable
   starts with no MCP servers and a warning in the log. An agent that cannot list a provider's
   issues is still an agent; failing the turn would make a connection outage look like a model
   outage.
6. **`mcp_url` is overridable per connection, like `api_base`.** A self-hosted or enterprise host
   runs its own MCP server, and the manifest's public URL is wrong for it. The override rides in
   the connection's metadata, is accepted on the create route, and is the same escape hatch
   `api_base` already was.
7. **`session.create` carries `mcp_servers`.** Additive to §7.6: `[{name, url, token}]`, mapped on
   the runner onto ACP's `McpServerHttp` with an `authorization` header. The token travels in the
   agent's session configuration, not the runner's environment, so nothing the agent spawns
   inherits it.
8. **Denials are audited before the upstream is touched.** `tools.called` carries the caller, the
   connection, the tool, a SHA-256 of the arguments, and `ok | error | denied`. The hash, never the
   arguments: a tool call's arguments are exactly the sort of thing that should not be readable in
   an audit log a whole workspace can list.

### Consequences
An ACP agent gets a provider's tools without ever holding a provider's credential, and a workspace
can see what its agents called. What is not here: `requires_permission` tools returning pending with
an inbox item (there is no inbox until Phase 2), runner-local stdio servers behind the same shape,
rate limits, Perch's own `/mcp/perch` server, and the grants UI — task 2.14 and later.

### What could not be verified here
This build environment cannot reach `api.githubcopilot.com`, so the acceptance runs against a
stand-in MCP server on localhost, reached through the connection's `mcp_url` override — the same
field a GitHub Enterprise install would use. What is proven is the whole path: an ACP agent lists
and calls a tool through `/mcp/{connectionId}`, the provider sees only its own PAT, the runner sees
only Perch's token, the allow-list refuses a tool, and both outcomes are audited. What is *not*
proven is that GitHub's own MCP server accepts the same traffic. Whoever has a fine-grained PAT
should point a connection at `https://api.githubcopilot.com/mcp/` and confirm before relying on it.

## ADR-0084: Previews are a proxy with two doors, and a ticket to get through either

- Status: accepted
- Date: 2026-09-15
- Task: 1.18

### Context
§5.6 says every listening runner port becomes `https://<port>--<workspace>.preview.<domain>` with a
path-mode fallback at `/p/<workspace>/<port>/`, gated by the Perch session, with WebSocket
passthrough for HMR and share links that expire and revoke. What it does not say is where the api
reaches a runner's port, how a browser stays signed in on an origin that is not Perch's, or what
happens to a dev server's own HMR configuration in the middle.

### Decision
1. **One hostname label, not two.** The preview host is `<port>--<workspace>.<PERCH_PREVIEW_DOMAIN>`
   rather than §5.6's `<port>--<workspace>.preview.<domain>`: a `*.<domain>` wildcard certificate
   covers exactly one label, and one label is what §8's Caddyfile (`*.{$PERCH_PREVIEW_DOMAIN}`) asks
   for. `.env.example` already pointed the variable at `preview.perch.example.com`, so the "preview"
   part lives in the operator's domain, where it belongs.
2. **A runner says where it can be reached.** `runner.register` gains an optional `preview_host`
   (additive to §7.6). A hosted runner is a container on the api's own network and names itself; the
   in-process runner is loopback; a laptop stays silent, because the api has no route to it, and
   gets the tunnel of task 1.19 with an error that says so rather than hanging.
3. **The proxy is thin on purpose.** Hop-by-hop headers are dropped, Perch's own cookie and
   authorization never go upstream, redirects to the dev server's own origin are moved under the
   path prefix in path mode, and bodies are streamed. A dev server is a moving target; the less the
   proxy reinterprets, the fewer frameworks it breaks.
4. **Perch's framing headers stop at the preview.** X-Frame-Options and the COOP/COEP family are
   Perch's own; applied to a proxied response they would keep the Preview tab from framing it at
   all. The shell skips them for preview requests, which is what §5.6's "CSP relaxed for previews"
   means in practice.
5. **A member gets in with a ticket, not a cookie Perch cannot send.** A preview's origin is not
   Perch's, so the session cookie does not reach it. The Preview tab puts a short-lived HMAC ticket
   (workspace, user, port, fifteen minutes) on the frame's URL once; the proxy exchanges it for a
   cookie on that origin and the dev server's own links work from there. Over HTTPS the cookie is
   `SameSite=None; Secure`, so it survives the frame; over plain HTTP it is `Lax`, which is enough
   when the preview domain sits under Perch's own domain — the layout the docs recommend and the
   Caddyfile assumes.
6. **A share is a hash and an expiry.** `preview_shares.token_hash` holds a SHA-256 of a 32-byte
   token; Perch cannot show a link twice. A share opens one port in one workspace until it expires
   or is revoked, and `runner_id` became nullable (migration 0012) because a share is resolved by
   port when it is used — a restarted container should not invalidate a link, and laptop mode has no
   runner row to point at.
7. **HMR works out of the box in wildcard mode, and takes one line in path mode.** Vite 8's client
   dials the page's own origin, which in wildcard mode is the preview's — so the socket comes
   through Perch and nothing needs configuring. In path mode the same client dials the root of
   Perch's origin, because it has no way to know the prefix; a project that wants hot reload there
   sets its dev server's `base` (or `server.hmr.path`). That is why §5.6 makes the wildcard the
   primary and the path the fallback, and why the docs say so plainly.
8. **Never 22, 5432, 6379.** The proxy answers only for ports a workspace's own runner reported
   listening, and refuses a short list that is never a dev server. A preview is a window onto an
   app, not a tunnel to the database.

### Consequences
A dev server on a runner is watchable from anywhere, on a phone or a desktop, with its hot reload
intact and a link you can hand to someone who has no account. What is not here: the inspector and
click-to-source, the console strip, screenshots, and previews on a local runner — 1.19 and Phase 2.

### What was actually verified
The acceptance runs a real Vite 8 dev server beside the e2e server and watches it through Perch:
the page renders in the Preview tab, an edit to one of its modules changes the page without a
reload, and the socket that carried the update was on the preview's hostname while the dev server
was never reached directly — a deliberately mutated build (WebSocket passthrough disabled) fails
that assertion, which is how we know it is not Vite's own direct-connection fallback passing the
test. Path mode is exercised over HTTP in the same spec. The e2e instance answers on
`perch.localhost` with previews on `<port>--<slug>.perch.localhost`, which is the recommended
production layout with `localhost` standing in for the domain — and a secure context, so passkeys
and WebCrypto still work in the rest of the suite.

## ADR-0085: The message catalog is split by route, and the entry chunk is checked for leaks

- Status: accepted
- Date: 2026-09-15
- Task: 1.18

### Context
§9.1 says every user-facing string goes through `t("key")`. The catalog was one JSON file imported
by the i18n module, which the shell imports, so it shipped whole in the entry chunk: 21.9 KB of
strings in front of the first paint, growing with every screen. Task 1.15 added 30 keys, 1.16 added
28, and at 179.2 KB of a 180 KB budget (ADR-0072) the Preview tab would have breached it. Raising
the budget would have been the wrong answer: the strings were not needed yet.

### Decision
1. **`en.json` is the shell's vocabulary.** The rail, the sidebars, sign-in, the command palette,
   settings' chrome, the setup wizard — everything the first screen can say.
2. **A route's vocabulary is a fragment beside it.** `en.code.json` (editor, files, terminal,
   session, diff, projects, preview) and `en.settings.json` (brains, connections) register
   themselves through a side-effect import; ES module order guarantees the strings are in the
   catalog before anything in the chunk renders. `t()` and `MessageKey` are unchanged for callers:
   the key union spans every fragment, so a typo is still a type error.
3. **The import goes in a component module, never a route file.** TanStack Router's
   autoCodeSplitting keeps a route file's own imports in the eagerly loaded half, so a fragment
   registered there lands in the entry anyway. A route's components register it instead, and the
   route's own `t()` calls live in the component half that loads with them.
4. **A barrel-reachable component cannot register for itself.** A side-effect import is never
   tree-shaken, so it rides into the entry even when the component it sits in does not. Subpath-only
   components (SessionTranscript, DiffView) register for themselves; EditorGroup's consumers do it
   for it, its demo included.
5. **`bun run perf` fails on a fragment key found in the built entry chunk.** That catches both
   mistakes at once — a shell string filed under a route, and a fragment dragged into the first
   paint — and it is checked on the build, where the truth is.
6. **Setup and invite stay in the core catalog.** They are single-file routes with no component
   module to hang a fragment on, and contorting a route to save 660 bytes is not worth the reader's
   confusion.

### Consequences
Initial js+css went from 179.2 KB to 176.5 KB with no change to what any screen says, and a route's
strings now cost the route rather than the first paint. A second locale would follow the same split.
The rule to remember: a fragment key may only be used from a module in a chunk that imports the
fragment, and the perf audit is what enforces it.

## ADR-0086: The preview tunnel is framed text over the runner's own stream

- Status: accepted
- Date: 2026-09-15
- Task: 1.19

### Context
§5.6 says that for local runners the api tunnels HTTP and WebSockets through the runner's
connection, and §7.6 gives the method: `http.open {port, path, method, headers}` → a stream token,
"carries request body then response head and body; WebSocket upgrades tunneled the same way". What
it does not give is the shape of what crosses that stream — and a `RunnerStream` carries text, while
an HTTP body does not.

### Decision
1. **One frame per line, tagged, with bytes in base64.** `b:` bytes, `t:` text, `h:` the response
   head as JSON, `o:` the upgrade succeeded, `e:` end of body, `c:` closed, `x:` failed. The
   encoder and decoder live in `packages/events` so both ends share one definition, and a frame a
   side does not understand is dropped rather than guessed at. Base64 costs a third more bytes on a
   lane that is already the slow one; mangling an image costs more.
2. **The runner makes the request, so it only ever reaches its own loopback.** The api sends a port
   and a path; the runner fetches `http://127.0.0.1:<port><path>`. There is no host to smuggle and
   nothing else on the machine to reach.
3. **Direct where it works, tunnelled where it does not.** `PreviewService.reach` returns a direct
   host for a runner that published one (task 1.18) and a tunnel for one that did not. Nothing in
   the Preview tab, the URLs or the share links changes between them; only which way the bytes go.
4. **A tunnelled request runs as the person who got in.** A member's request acts as that member; a
   share link's acts as whoever created the share. That is what §7.6's owner check on a local
   runner reads, and on-behalf-of is the honest reading of a shared preview.
5. **Perch's credentials never cross.** The same header rules as the direct proxy: hop-by-hop
   headers, `cookie` and `authorization` are dropped before the request leaves the api
   (AGENTS.md §1.6).

### Consequences
A dev server on a laptop is watchable from a phone with no port forwarding, no tunnel service and no
inbound firewall rule. The cost is latency and a base64 tax on every byte, paid only by runners that
need it. `mcp.spawn` can use the same framing when task 2.x needs it.

### What was actually verified
`apps/api/test/preview-tunnel.test.ts` connects a runner the way `perch runner connect` does — a
real socket to `/api/runner`, a real token, `kind: "local"` and no `preview_host` — and asserts the
lane is the tunnel, then pulls a page, a 200 KB request body, a binary body whose bytes are not
valid UTF-8, and a WebSocket relayed frame for frame in both directions. A port nothing is serving
fails as a preview error rather than hanging. The browser half — the Preview tab at a phone's
viewport — is task 1.18's Playwright spec; this environment has one machine, so a spec cannot have a
laptop runner the in-process runner cannot also see, and the tunnel lane is therefore proven at the
api rather than through Chromium.

## ADR-0087: The Git panel stages by selection, and writes messages on the inline lane

- Status: accepted
- Date: 2026-09-15
- Task: 1.20

### Context
§5.1 asks for a git panel with "status, stage, AI commit message, branch, push, Open PR". Two of
those words hide decisions: "stage", because Perch has no index of its own, and "AI commit message",
because a draft has to run somewhere and every lane so far costs a session.

### Decision
1. **Staging is a selection, not an index.** The panel ticks paths and `git commit` takes them;
   Perch never runs `git add` on its own. An index Perch managed would drift from the one a session
   or a terminal in the same checkout is using, and a person would have two notions of "staged" to
   keep straight. What you tick is what lands; ticking nothing commits everything that changed.
2. **The message runs on the inline lane.** The same one-prompt, one-answer, nobody-watching lane ⌘K
   uses (task 1.14): no session pane, no permission prompts, no transcript. `inlineEdit` and
   `commitMessage` are now two prompts over one `inlineRound`.
3. **The draft is written against a ref, not the index.** A new file is the usual case for a
   feature's first commit and is invisible in `git diff` alone, so the message is drafted from the
   working tree against HEAD — or against git's empty tree when the repository has no commits yet.
4. **Push and Open PR borrow a connection for one call.** The same credential path a clone takes
   (task 1.16): minted, used, forgotten. A push with no connection still goes, for a remote that
   needs no credential; Open PR without one is disabled with a line saying why.
5. **Every button is a route.** `git/status`, `git/diff`, `git/commit`, `git/message`,
   `git/branches`, `git/push` under the project, beside the `pull-request` route task 1.16 added.
   The panel is a client of the api like anything else, and a script can do what it does.
6. **The commit is the member's.** `git.commit` carries the member's name and email as the author
   (ADR-0070), so a commit made from Perch is attributed to the person who made it rather than to
   whatever git config the runner image happens to carry.

### Consequences
The loop §2 names — clone, ask for a change, watch it, review the diff, commit, PR — is now
clickable end to end. What is not here: the Pull Requests page with inline comments and "ask the
agent to address review" (Phase 3), and a hunk-level stage (the session pane's DiffView has hunk
accept and reject; the panel's unit is a file).

### What was actually verified
`e2e/git.e2e.ts` at both viewports: a file edited in the editor shows up in the panel, the agent
writes the message from the diff, the commit lands and the panel goes quiet, and a branch is made
from the panel. `apps/api/test/git-panel.test.ts` covers the same routes directly against a real
repository on the in-process runner, including a push with no remote failing as a git failure rather
than a hang. Push and Open PR against a provider are `apps/api/test/connections.test.ts`, which
drives them against a stand-in GitHub over authenticated smart HTTP — this environment cannot reach
the real one.

## ADR-0088: Laptop parity is one process driven over HTTP, on a laptop the test declares

- Status: accepted
- Date: 2026-09-15
- Task: 1.21

### Context
§2 promises the same product with and without Docker, and Phase 1 built twenty tasks' worth of
features against the server. Nothing so far proved that a person who downloads the binary gets them:
the laptop smoke from task 0.14 starts `perch dev` and asks whether it is alive, which a broken
runner, a missing engine, or a preview that never reaches the dev server would all survive.

### Decision
1. **The parity test spawns the real binary and speaks only HTTP.** `apps/cli/test/parity.test.ts`
   runs `bun apps/cli/src/index.ts dev` on a real port against a temporary data directory, completes
   the setup wizard the way the browser does, signs in, and then drives Phase 1 through the api: a
   project, the file system, git with a drafted message, a session with a permission and its diff,
   ⌘K, a brain against a stand-in provider, a connection, the gateway's challenge, a preview with a
   share link, and a terminal. Nothing imports laptop-mode internals, so the test cannot pass on a
   code path the binary does not take.
2. **The laptop is declared, not inherited.** The machine a test simulates has exactly one agent on
   it — the fake ACP one from the runner's fixtures, handed over in `PERCH_ACP_AGENTS` — so the
   child gets a `PATH` with any `opencode` filtered out. A runner reports the engines whose programs
   it can find, and a new project's default engine is `opencode` (§6), so an OpenCode that happens
   to be installed would capture the two lanes with no engine picker (⌘K and the commit message) and
   send the round off the machine. The test asserts the engine the inline session actually opened
   on, so a change here fails loudly instead of reaching for the network.
3. **A spike may not leave the process changed.** `spikes/opencode/spike.test.ts` put its own
   `node_modules/.bin` on `process.env.PATH` at module scope; a root `bun test` runs every file in
   one process, so every later test saw an OpenCode that the machine did not have. The mutation now
   lives between the spike's `beforeAll` and `afterAll`. Spikes stay runnable (§9.3) but are no
   longer allowed to decide what the rest of the suite believes about its environment.
4. **Stand-ins, not the internet.** The brains lane talks to a local OpenAI-shaped `/models`, the
   connections lane to a local GitHub-shaped `/user`, and the preview lane to a local dev server on
   a real port. The whole test passes with the network unplugged, which is the point: laptop mode is
   what works when nothing else is reachable.

### Consequences
Phase 1 now has a floor under it: a feature that only works with Docker fails here. The lanes this
test drives are the ones task 1.22 will drive through the browser, on four engines.

What it does not cover: OpenCode and the credentialed engines (task 1.22 runs those on a real key,
on Ollama, through OpenCode, and through ACP), Docker-only paths such as the supervisor, and the
desktop wrapper, which has its own tests.

### What was actually verified
`bun test apps/cli/test/parity.test.ts` — five lanes green against a real `perch dev`. Reverting
both halves of decision 2 and 3 and running `bun test spikes/opencode/spike.test.ts
apps/cli/test/parity.test.ts` reproduces the failure they fix: the commit-message and ⌘K lanes come
back `502 upstream_failed` from an OpenCode that leaked onto the path, reaching for a provider
catalogue this environment cannot fetch.

## ADR-0089: The exit criterion is one spec run four times, against stand-ins for everything off this machine

- Status: accepted
- Date: 2026-09-15
- Task: 1.22

### Context
§2 ends Phase 1 with a sentence: clone via GitHub, ask for a change, watch it in Preview from a
phone, review the diff, commit, open a pull request — "on a paid key and on Ollama, through
OpenCode and through ACP, and the same from `curl | sh` with no Docker". Every part of that exists
by task 1.21 and each has its own spec; nothing had yet run the whole sentence in one go, and three
of its four ways need something this project deliberately does not ship: a paid key, a GitHub
account, and an OpenCode installation with a model behind it.

### Decision
1. **One spec, four Playwright projects.** `e2e/phase1.e2e.ts` is the sentence, start to finish.
   `phase1-key`, `phase1-ollama`, `phase1-opencode` and `phase1-acp` each run it with a lane in
   their `metadata`, so the four green runs the task asks for are four rows in the report rather
   than four copies of a spec that would drift apart. `bun run e2e` runs them with everything else.
2. **A phone's viewport, always.** The criterion says "from a phone"; the loop's hardest screens are
   the ones that become sheets there. The desktop projects skip this spec rather than doubling it.
3. **The lanes differ where a test can see it.** Each asks the agent which provider variables it was
   started with before asking for the change: `OPENAI_API_KEY, OPENAI_BASE_URL` on the key lane,
   `OLLAMA_HOST` on the Ollama one, `env: none` on the lane with no credential at all — names, never
   values (§1.6). The OpenCode lane is told apart by what lands in the diff, which only its adapter
   can write. Four runs that could pass identically would prove one thing four times.
4. **Stand-ins for everything off this machine, and the real thing for everything on it.** A stand-in
   GitHub per lane (`git http-backend` over smart HTTP, plus `/user`, an installation token, and
   `/pulls`) so the clone, the push and the pull request really happen against credentials the
   harness can inspect; the provider that answers the key and the endpoint; a real Vite dev server
   for the Preview tab; and the runner, the api, the engines and the browser as they ship. A "paid
   key" is therefore a credential of kind `api_key` against an OpenAI-shaped endpoint — the path a
   real key takes, minus the vendor, which is the most a project with no paid plans (ADR-0064) can
   run on every push.
5. **OpenCode runs on the adapter's own `baseUrl` seam.** `PERCH_OPENCODE_URL` names an
   `opencode serve` already running, and a runner told about one talks to it instead of spawning
   per project. It is not a test-only seam: pointing a runner at a server you run yourself is a
   reasonable way to run OpenCode, and the refusal message now names it. The harness points it at
   the stand-in from task 1.10's own tests, because the real binary needs a provider key and the
   internet to answer a prompt — the binary itself is spike 0.4.3's subject (ADR-0031).
6. **Each lane gets its own origin, and pushes to its own branch.** Four runs of one loop must not
   see each other's work: a second lane cloning the first lane's push would find the change already
   made and nothing to commit. A branch named for the lane and the minute also makes a retry clean.
7. **Two gaps the criterion exposed, both filled here.** Cloning through a connection was an api
   route with no way to reach it from Code mode; it is now the "A connected service" choice under
   Authentication. And a connection could only ever point at the public service, which left GitHub
   Enterprise (and this spec) with nowhere to go; the Connect form now has an API base field, which
   is the field the api already accepted.

### Consequences
Phase 1 has an acceptance that fails when any part of the loop breaks, on every push, in about
thirty seconds. What it does not prove is a real model's judgement: every lane's agent is a
stand-in, so the spec says the loop works, not that the change is good.

A side effect worth knowing: with an OpenCode server reachable, a project that ships no
`.perch/project.json` runs its picker-less lanes — ⌘K and the drafted commit message — on OpenCode,
because `opencode` is a new project's default engine (§6). That is correct, and it is why the
stand-in now answers those two prompts and why the exit-criterion repository declares
`"engine": "acp"`.

### What was actually verified
`bunx playwright test --project=phase1-key --project=phase1-ollama --project=phase1-opencode
--project=phase1-acp` — four passed. The whole suite (38 specs across six projects) is green, and
`bun run check` covers the fixture the api's connections test now shares with the harness.

## ADR-0090: A channel is a room with one lock: archiving

- Status: accepted
- Date: 2026-09-15
- Task: 2.1

### Context
§5.2 asks for channels — public, private, DMs, groups and item threads — with membership, a header,
archiving, and sidebar sections weighted by unread. The schema for all of it landed in task 0.5, so
what this task decides is who may do what, and what the client is told.

### Decision
1. **One lock, and it is archiving.** Starting a channel, renaming it, setting its topic and adding
   people are every member's to do (`channels.create`, `channels.update`); archiving is owners' and
   admins' (`channels.archive`). A workspace where a member cannot start a conversation is not a
   workspace; archiving, though, takes a room away from everybody in it, so it sits with the people
   who answer for the place. Deleting a channel is not offered at all: an archive keeps what was
   said, and a delete is the one action nobody can undo.
2. **A private channel is private down to its name.** A channel the caller may not see answers 404,
   never 403 — the same rule the workspace itself follows. The listing is filtered the same way:
   every public channel, plus the private ones, DMs, groups and item threads the caller is in.
3. **Joining is a membership, not a request.** A public channel is open to every member of the
   workspace; anything else has to be opened from the inside by somebody already in it. Joining
   twice is the membership you already had, not a second row and not an error.
4. **Unread is counted by id, not by time.** The read mark is a message id and ids are UUIDv7
   (ADR-0025), so "newer than the mark" is `id > mark.id`. A timestamp comparison ties when two
   messages are written in the same instant — which a batch insert does every time — and a tie in
   this query silently loses an unread message. The count leaves out the caller's own messages and
   anything deleted.
5. **A join or a leave is a `channel.updated`, not an event of its own.** §7.2's event names are the
   contract the client subscribes to; membership changes travel as `channel.updated` with
   `changes: ["members"]`, which is enough for the sidebar to refetch and keeps the event list as
   the spec has it. Archiving keeps its own `channel.archived`, because it means something different
   to everybody in the room.
6. **The room, not the conversation.** A channel with no messages says so, because messages are task
   2.2 and a screen that pretends otherwise would be a lie. The header, the topic, the member list
   and the sidebar weight are all real; the body arrives next task.

### Consequences
Phase 2 has somewhere to put a message. The sidebar's weight is already computed from `read_state`,
so 2.2 turns it on rather than adding it.

What is not here: DMs and groups have routes and a section but no way to start one from the UI (they
need the people picker that comes with mentions in 2.2), muting, and the channel header's pins and
bots, which are 2.2 and 2.6.

### What was actually verified
`e2e/channels.e2e.ts` at both viewports: a channel is created and named `#release-notes`, its topic
is set, it appears in the sidebar, a second person in a second browser joins it from Home and leaves
it from inside it — with the member count changing under the first person's eyes both times — and an
owner archives it, which marks it and drops it out of the sidebar while a member has no such button.
`apps/api/test/channels.test.ts` covers the rules directly: name normalization and the conflict, who
sees what, joining twice, adding from the inside, the unread count with messages seeded in the
table, and a member refused the archive that an owner is allowed.

## ADR-0091: On a tunnel stream, the side that sent the last frame never hangs up

- Status: accepted
- Date: 2026-09-15
- Task: 1.19 (fix forward)

### Context
CI went red on `e72c550` with one failure: the preview tunnel's acceptance test posted 200 KB
through a laptop runner and got 49,152 bytes back — three 16 KiB chunks — with a 200 status, no
error frame, and nothing in any log. It passes on an idle machine and fails on a loaded one, which
is the signature of a race rather than a wrong answer.

The cause is in Bun's client WebSocket: `close()` throws away whatever it has not yet written.
A probe makes it plain — a client that sends fourteen frames and closes in the same tick delivers
five of them; the same client that sends the fourteen and lets the peer close delivers all fourteen.
The runner's half of the tunnel did exactly the losing thing: it wrote the dev server's answer,
sent `end`, and hung up. On a quiet machine the queue had already drained; on a busy one — a CI
runner with the api, the runner and PGlite sharing one event loop — most of the answer was still in
the queue when the socket went.

The api made it invisible: when a stream closed mid-answer it closed the response body, so a
truncated page looked like a complete one.

### Decision
1. **The receiver hangs up, not the sender.** The runner finishes a tunnelled exchange by sending
   its last frame — `end`, `close`, or `error` — and then leaving the socket alone. The api closes
   the moment it has the whole answer, which it already did. A 30-second timer on the runner is
   insurance against an api that never closes, not the mechanism. §7.6 says a stream is "closed by
   either side"; this narrows that to "closed by the side that is reading", which is the only side
   that can close without losing what is in flight.
2. **A stream that dies mid-answer is an error, not a short page.** If the api's stream closes while
   the response body is still open, the body is errored rather than closed. A browser that gets half
   a page should see a failed request, and a test that sees one should fail.
3. **The runner keeps closing streams it never wrote to.** A refused token or an unclaimed stream is
   closed immediately: there is nothing queued, so there is nothing to lose.

### Consequences
The 200 KB round trip is whole under load, and any future loss is loud instead of silent. The same
hazard exists wherever a runner writes to a stream and then closes it — `pty` closes its stream when
a shell exits, and can drop the shell's last lines the same way. That is task 1.7's protocol to
change (the api would have to learn "the shell ended" from a frame rather than from the socket) and
is not done here; this ADR is the record that it is known.

### What was actually verified
`apps/runner/test/http-tunnel.test.ts`: the runner's tunnel against a stand-in api over a real
client WebSocket, a 200 KB echo — the answer arrives whole and the api is the side that hangs up.
The test fails on the old code (`hungUpBy: "runner"`, the body short) and passes on the new.
`apps/api/test/preview-tunnel.test.ts` (the acceptance for task 1.19) and
`apps/cli/test/parity.test.ts` stay green, as does `bun run check`.

## ADR-0092: A message is blocks, a thread is one deep, and unread is what the flow shows

- Status: accepted
- Date: 2026-09-15
- Task: 2.2

### Context
§5.2 asks for messages with blocks, edit history, delete, threads with reply counts, a hover
toolbar, pins, bookmarks, read state, and mentions with autocomplete. The schema for most of it
landed in task 0.5; what this task decides is the shape on the wire, who may do what, and the three
rules that only show up once somebody is actually reading a channel.

### Decision
1. **Blocks, with `text` as a courtesy.** The column is `blocks jsonb` and the api validates the
   discriminated union before storing anything, so a bot's diff card and a person's "morning" are
   the same kind of thing. The composer's `POST` may send `text` instead, and the api makes the one
   block it is — a convenience for the client, not a second shape in the database.
2. **Edit history is a table, not a column.** `message_edits` (migration 0013) keeps the blocks each
   edit replaced, with who did it and when. §6 does not name the table; "(edited)" that cannot be
   opened is a claim rather than a history, and an array growing inside the message row would be
   the wrong place for an append-only trail.
3. **A thread is one deep.** Replying to a reply joins the same thread. Slack's rule, because a tree
   of replies is a thing nobody can follow in a chat window, and because the reply count on the root
   is then a number that means something.
4. **Replies are not in the channel's flow, and not in its unread.** The flow lists messages with no
   `thread_root_id`; the unread count does the same. Counting a reply would leave an unread that
   reading the channel could never clear, because the channel never shows it. Threads get their own
   surface in the Inbox (task 2.10).
5. **Deleting empties, it does not remove.** The row stays with `deleted_at` set and no blocks, so a
   thread keeps its shape, a reply count stays honest, and the transcript says plainly that
   something was taken down. Editing is the author's alone; deleting is the author's or an admin's
   (`messages.moderate`).
6. **A pin is the channel's, a bookmark is yours.** Anybody in a channel pins, and everybody in it
   sees the pin, so it travels as a `message.updated`. A bookmark is one person's Later list and is
   published to nobody.
7. **Mentions are `<@handle>` and `<#name>` on the wire.** §7.3 already promises bots that shape.
   The composer writes the token when somebody picks from the list; the client renders it back as a
   name. The list matches a handle *or* a name, because a handle comes from an email address and is
   frequently not what somebody is called.
8. **The mention list is a listbox beside a textbox, not a combobox.** The textarea keeps
   `role=textbox` — it is one, every caller finds it by that role, and the session composer would
   otherwise change shape too. The list is a `listbox` the textarea points at with `aria-controls`
   and `aria-activedescendant`; the caret never leaves the composer, which is what makes typing
   through a suggestion work at all.
9. **Reading is the client's statement.** `POST …/read` with the last message the client has shown.
   The api does not guess from a scroll position it cannot see.

### Consequences
Chat works: a team can talk, thread, pin and correct itself. The unread weight the sidebar has been
drawing since task 2.1 now has something to count.

What is not here: reactions, files and unfurls (2.3), interactive blocks (2.5), bots as authors
(2.6), and search (2.4). Message blocks from a bot are already storable — nothing else can write
one yet.

### What was actually verified
`e2e/messages.e2e.ts` at both viewports, two browsers: a message arrives for the other person; a
mention is picked from the list and lands as a mention rather than the token typed; a reply makes a
thread with a reply count; a pin shows for everybody and a save for only one of them; an edit shows
"(edited)" and opens what it said before; a delete leaves "This message was deleted."; and the
second person's unread badge goes quiet once they have read the channel. `apps/api/test/messages.
test.ts` covers the rules directly: posting into a channel you are not in is refused, paging by id
both ways, the edit history, a thread that stays one deep, pins against bookmarks, a mention that
weighs on the channel, a thread reply that does not, and the delete a member may not do to somebody
else's message. The mention list's keyboard and its axe pass are
`packages/ui/src/shell/composer.ct.tsx`.

## ADR-0093: Uploads are inert, identifiers unfurl as reads, and a phone is told by the bus

- Status: accepted
- Date: 2026-09-15
- Task: 2.3

### Context
§5.2 asks for reactions, file uploads with previews, unfurls for Perch identifiers, and web push,
with the acceptance that a push arrives on a phone for a mention. Three of those are ordinary
features over the 0.5 schema. The fourth is the first time Perch talks to a service outside the
instance on somebody's behalf, and files are the first time Perch serves bytes a stranger chose.

### Decision
1. **A reaction is the channel's, and yours is a toggle.** Everybody in the room sees every pill;
   the pill says how many and whether one of them is you. Adding the one you already have changes
   nothing and publishes nothing. An emoji is a handful of code points with no whitespace and no
   control characters — a reaction is not a second way to write a message.
2. **Every upload downloads; only drawable images preview.** `GET /api/files/{id}` always answers
   `application/octet-stream` as an attachment, with `nosniff` and a sandbox CSP, whatever the file
   says it is. `…/preview` serves the bytes as themselves only for PNG, JPEG, GIF, WebP and AVIF.
   SVG carries script, so it has no preview at all. Perch serves uploads from its own origin, where
   a rendered SVG or HTML file would be a session's worth of XSS; the allow-list is the whole
   defence and it is a short one.
3. **One path per upload, dedup later.** `storage_key` is a fresh uuid under the workspace, so two
   people who send the same bytes each keep the name they sent. `sha256` is recorded for the dedup
   that can come later without a migration. The preview of an image is the image: nothing is
   re-encoded yet, and the cap is 25 MB.
4. **A file block may only name a file of its own workspace.** Ids are guessable in the sense that
   any uuid is; posting or editing a message checks every `file` block against the channel's
   workspace, which is what stops one workspace pointing at another's upload.
   The other half of that rule is weaker and worth saying out loud: reading a file is authorized
   against its **workspace**, not against the channel it was posted in. A member of the workspace
   who has a file's id may read it even if it was attached in a private channel they are not in.
   Ids are UUIDv7, never listed, and only ever handed out beside a message the reader could already
   see — but this is not the same guarantee a private channel gives its messages. Making it the
   same means checking that some message naming the file is in a channel the caller can see, which
   needs a containment query over `messages.blocks` and a GIN index to go with it; that lands with
   search (2.4), which needs the same index. Until then a private channel's attachments are as
   private as their ids.
5. **An unfurl is a read, asked once per page.** `POST /api/workspaces/{ws}/unfurl` takes the
   identifiers the client found on screen and answers with a card for each one the caller could have
   opened — nothing else, not even a "you cannot see this". A private channel unfurls for its
   members only; an identifier from another workspace is not a card. The client asks once for
   everything visible rather than once per message.
6. **Push subscribes to the bus like everything else.** The push subscriber watches
   `message.created`, works out who was named, and notifies their devices. Nothing in the message
   path knows about phones. §7.7's event list is unchanged: no `mention.created` was invented for
   this.
7. **Perch ships the web push cryptography itself.** RFC 8291 encryption and RFC 8292 VAPID are a
   hundred lines of WebCrypto with no network of their own, and this is the one place a self-hosted
   Perch talks to a third party for a user — the less of that is somebody else's code, the better.
   The test is the other half of the protocol: it plays the browser, decrypting what Perch would
   POST from the specification rather than from the implementation.
8. **The instance's VAPID keys are made on first use**, kept in `instance_settings` with the private
   half sealed by the vault (`push:vapid`). Laptop mode notifies people with no configuration; a
   team instance needs no new env either.
9. **`push_subscriptions` is a new table** (migration 0014), which §6 does not list. A subscription
   is an endpoint and two keys per device and has nowhere else to live; `notifications` is the inbox
   of §6 and a different thing. The routes sit under `/api/me/push-subscriptions` and
   `/api/me/push-key`, which §7.1 also does not list — a device belongs to a person, not to a
   workspace.
10. **A device that is gone is retired, not retried.** A push service answering 404 or 410 marks the
    subscription expired; it is never offered again and nothing more is sent to it.

### Consequences
A channel can carry more than words, and somebody who is not looking gets told. The tests cover the
halves separately for a reason: no test machine has a real push service, so `apps/api/test/push.
test.ts` proves Perch encrypts and POSTs the right thing to the right devices, and `e2e/push.e2e.ts`
proves the worker turns a delivered message into a notification and an in-app line. Between them the
whole path is covered; neither half stands in for the other.

What is not here: a full emoji picker (six quick ones and no more), thumbnails, virus scanning,
S3-backed storage (`PERCH_S3_*` is still unread), unfurls for work items and pull requests, and mute
preferences — a person who wants quiet turns notifications off for the device.

The initial bundle is at 178.7 KB of its 180 KB budget. The toasts and the push helper are in the
entry because the shell renders them; the next feature that touches the entry will have to lazy-load
something or the budget moves, with its own ADR.

### What was actually verified
`apps/api/test/reactions.test.ts` (3), `files.test.ts` (5), `unfurls.test.ts` (4), `push-crypto.
test.ts` (5) and `push.test.ts` (4): pills and their counts with two people, the `reaction.*` events,
an upload said in a channel and served back with its headers, an SVG that never previews, a file
another workspace may not name, the unfurl rules including the private channel, the RFC 8291 round
trip against an independently written receiver, the VAPID signature verified against its own public
key, and a mention that arrives at a stand-in push service as ciphertext the test decrypts.
`e2e/reactions-files-unfurls.e2e.ts` and `e2e/push.e2e.ts` at both viewports: a reaction from the
toolbar and off again from the pill, a PNG attached and drawn (`naturalWidth > 0`), an identifier
that becomes a card, the worker registering, and a push delivered through the DevTools protocol
showing up as a live region with a link that lands in the right place.

## ADR-0094: Search is two queries, and a file is as private as the message it was said in

- Status: accepted
- Date: 2026-09-15
- Task: 2.4

### Context
§5.2 asks for "Postgres full-text over messages and files with filters" with a results page and a
peek, and the acceptance is 150 ms on 100,000 messages. The schema has had what search needs since
task 0.5: a generated `text_search` tsvector on `messages` with a GIN index. ADR-0093 also left one
thing open on purpose — files were authorized against their workspace rather than the channel they
were posted in — and said the fix would come with this task, because it needs the same index.

### Decision
1. **The matching is Postgres's.** `websearch_to_tsquery('english', …)` parses what people type —
   bare words, quoted phrases, `or`, `-not` — without throwing on punctuation, and `ts_rank_cd`
   ranks. No second index, no search service (spec §3.1).
2. **Two queries, not one.** The first picks ids and ranks and takes the top of them; the second
   fetches those rows and joins the channel and author names. Measured on 100k messages in PGlite
   with a term matching a third of them: one query that ranks and sorts whole rows (blocks jsonb and
   tsvector included) takes ~145 ms; ranking the id/rank pair and fetching thirty rows takes ~45 ms.
   The acceptance is met with room to spare, and it is met by the shape of the query rather than by
   a warm cache.
3. **Scope before filter.** Every search is restricted to the channels the caller can see before any
   filter is applied. A `channel` they cannot see is refused through `channelFor` — 404, the same
   answer the channel itself gives (ADR-0090) — rather than quietly returning nothing, because an
   empty result would confirm the channel exists.
4. **Files are matched by name.** A file name is short and a workspace has thousands of files, not
   millions; `ilike` over them is cheaper than a second tsvector to maintain. If that stops being
   true, the column is there to add.
5. **A file is as private as the message it was said in.** Reading a file now requires being its
   uploader or seeing a message that points at it in a channel the caller can see, which is what
   ADR-0093 left open. The check is a jsonb containment — `blocks @> '[{"type":"file","fileId":…}]'`
   — with a GIN index (`jsonb_path_ops`, migration 0015) behind it. A file nobody has posted is its
   uploader's alone; anything else answers 404, not 403, so an id proves nothing.
6. **Results are marked, not summarized.** The api returns the message; the client marks the words
   that matched. `ts_headline` would mean a second parse of every result on the server for a
   fragment the client can produce from text it already has.
7. **A result opens as a peek** (spec §4) with "Open full" to the channel, because following a
   result straight out of the page loses the list of results.

### Consequences
Chat is searchable and the last hole in file privacy is closed. The `messages_blocks_idx` that does
it is also what a "which messages carry this file" question will want later.

What is not here: search over sessions, work items and code (spec §5.7's `@codebase` is Phase 3),
`type=files` ranking (files come back newest first), highlighting inside code blocks, and paging —
a search answers with its best 50 and asks you to narrow rather than scroll.

### What was actually verified
`apps/api/test/search.test.ts`: stemming and phrases and `-not`; the filters; a private channel that
keeps its messages and its attachments to its members, including the 404 for naming it; files found
by name only where they could have been seen; and the acceptance — 100,000 messages seeded in the
database, three searches, the slowest under 150 ms (about 50 ms in practice, printed by the test).
`e2e/search.e2e.ts` at both viewports: two channels, a word in each, the marked results, the channel
filter narrowing them to one, the peek and its "Open full" landing in the right channel, and a
search that finds nothing saying so.

## ADR-0095: An answer lives in the block, and reaches a bot off the bus

- Status: accepted
- Date: 2026-09-15
- Task: 2.5

### Context
§5.2 asks for interactive blocks — `button`, `select`, `form`, `approve_deny`, `progress` — where
"interactions post `interaction.received` {block id, values, user, message} to the owning bot over
the Bot API and update the block in place". Two questions are left open by that sentence: where the
answer is kept, and which seam the payload travels on. The bus catalog is exactly §7.7's list and
`packages/events/test/events.test.ts` asserts that nothing else is on it, while `interaction.received`
is a §7.3 Bot API event — so it cannot simply be published. A bot cannot author a message until the
runtime lands in 2.6, and the transports for the Bot API (the socket, the signed webhook) arrive
with 2.6 and 2.7.

### Decision
1. **The answer is written into the block** as `state` on `messages.blocks`: who answered (`byType`,
   `byId`, `byName`), when, and the values. The message carries its own outcome, so the person who
   opens the channel tomorrow reads the same thing as the person who pressed the button — no second
   request, nothing to replay, and one row to keep. `approve_deny` also keeps its `decision` field,
   because the spec gives it one.
2. **Answering is not editing.** `updateMessageBlocks` takes `history: false`: no `message_edits`
   row, no `editedAt`, no "(edited)" mark. Nobody rewrote the message; a question it asked was
   answered, and what changed is visible in the block itself. Filing it as an edit would make the
   history a log of everyone's clicks and put "(edited)" on a message nobody edited.
3. **A block is answered once.** The first answer wins and a second is refused (409). A block with
   no `id` cannot be answered at all: there would be no way to say which of two buttons was pressed.
4. **Answering is writing in the channel** — the same membership check as saying something there,
   not a weaker one. A reader sees the question and is offered no controls.
5. **`interaction.received` goes on its own seam**, `createBotEvents()` in `packages/bots`, not on
   the bus. The bus catalog stays exactly §7.7; the Bot API keeps its own Slack-shaped envelope
   (`{type, botId, workspaceId, payload, ts}`), and the transports in 2.6 and 2.7 subscribe there
   rather than being wired into the features that emit. It is in-process like the bus: a subscriber
   that throws never fails the person who clicked, and an event with nobody listening is not an
   error. `botId` is null until a bot can own a message.
6. **The in-place update travels as `message.updated`**, which is already on the bus and already
   fans out over the WebSocket, so every open tab redraws the block at once with nothing new added
   to the catalog.
7. **`BlockRenderer` is one component behind a subpath** (`@perch/ui/blocks`), not the package
   barrel, because it carries the chat i18n fragment and the barrel is reached from the entry chunk
   (ADR-0085). It renders the five kinds and their answered states; the app keeps the blocks that
   need its own data — text with its mentions, files — and passes them in as `fallback`.
8. **A select sends on a button, not on change.** A native `select` fires `change` per arrow key
   while it is closed, and an answer is one-shot and final: the keyboard would spend it on the first
   option passed over.

### Consequences
A bot can ask a question in a channel and be told the answer, and the message is the record of it.
The Bot API seam exists before anything can transport it, which is what lets 2.6 and 2.7 subscribe
rather than reach into chat.

What is not here: a `form` that opens as a modal (§5.2 says "(modal)"; it renders inline, which is
what works at 390 px and keeps the answer beside the question — a modal can wrap it later without
changing the contract), editing an answered block back to unanswered, per-person answers (one block,
one answer), and the rate limit §7.3 gives bots, which belongs with the Bot API's own routes in 2.6.

### What was actually verified
`apps/api/test/interactions.test.ts`: an approve button answered, its `state` and the §7.3 payload
checked field by field, `message.updated` published, no `message_edits` row and no `edited_at`, a
second press refused; a select and a form checked against the block that asked (a value that is not
an option, a missing required field); a block that is not there (404), a text block and a `progress`
block refused as not questions (409); somebody outside the channel refused, and a deleted message
refused. `packages/bots/test/events.test.ts`: the §7.3 catalog, the payload schema rejecting an
extra field and a bad block type, and a throwing subscriber that never fails the caller.
`packages/ui/src/components/blocks.ct.tsx`: all five kinds, answered in place, axe clean at both
viewports, a reader offered nothing to press, and no horizontal overflow at 390 px.
`e2e/interactive-blocks.e2e.ts` at both viewports: a message of blocks posted over the contract a
bot will use, arriving without a reload, approved and answered in place with no "(edited)" mark, a
select showing the option's label afterwards, and the same thing after a reload.

## ADR-0096: A bot is a member with a ledger, and everything it is told is somebody's words

- Status: accepted
- Date: 2026-09-15
- Task: 2.6

### Context
§5.3 describes a bot as identity, persona, brain, tools, triggers, scope, memory, budget, rate limit,
owner and visibility, with four ways to make one; task 2.6 is the first of them — the native runtime
— and its acceptance is "a template bot answers a mention within budget". The schema for it (§6
`bots`, `bot_installs`, `bot_runs`, `bot_memories`) did not exist yet, nothing in Perch had ever
called a model directly (sessions call engines on runners), and §7.7's bus catalog has events for a
bot's runs and installs but none for the bot itself.

### Decision
1. **A bot is a member of the channels it is installed in.** `bot_installs` carries the scopes, and
   the install also writes the `channel_members` row that the rest of chat already understands — so
   a bot reads and writes with the same checks as anybody else, and its name and `BOT` badge come
   from the same join as a person's.
2. **The brain is a model profile, called through the AI SDK.** `@perch/gateway` turns a profile
   into a language model: first-party adapters for the providers Perch knows, OpenAI-compatible for
   everything else. The credential is decrypted in `BrainsService`, handed to the gateway, and held
   by the model object for the length of one call — never in a prompt, a log line, a bot's context
   or a response (AGENTS §1.6).
3. **A bot runs on its owner's credential**, and a workspace-visible bot therefore needs an admin to
   create it (`bots.admin`): spec §3.6's "a bot visible to more than one person runs on Lane A or a
   local model" is about whose money and whose account a shared bot spends.
4. **Budgets are checked against the ledger.** Every turn writes a `bot_runs` row with tokens and
   cost, so `dailyUsd`, `perRunUsd` and `perHourRuns` are arithmetic over rows rather than a
   guess. A bot over its budget answers with the reason instead of going quiet — silence looks like
   a broken bot — and the refusal is recorded. A run that overruns what was left finishes and says
   so: the money is already spent, and the honest thing is to show it.
5. **The reply is a placeholder that fills in** (§5.4), and rewriting it is not an edit: no
   `message_edits` row, no "(edited)" — the same `history: false` path interactive blocks use
   (ADR-0095). A channel's answer goes in the thread of the message that asked; a DM has no thread
   to open, so it goes in the conversation.
6. **Tool outputs are wrapped as untrusted, without exception**, and the system prompt says what the
   wrapper means. The wrapper is applied by the registry rather than by each tool, and content that
   tries to close it early has its tags stripped first.
7. **`http_fetch` refuses the network Perch runs on**: no loopback, link-local, private range or
   `.internal`/`.local` name. A bot is not a way to reach the metadata service or a neighbour's
   port. `web_search` is a pluggable endpoint (`PERCH_SEARCH_URL`, Brave-shaped) and says it is not
   configured rather than inventing results.
8. **Triggers are a pure function** of the spec and what happened (`packages/bots/src/triggers.ts`),
   so the rule a bot answers by can be read and tested without a database or a model. `channel_join`
   is the bot's own arrival rather than everybody else's, which is the reading that does not turn a
   greeting into a doorbell. Schedules are the queue's: `bot:<id>:<n>` keyed cron rows on the `bots`
   queue, rescheduled whenever the spec changes.
9. **The runtime never touches Perch.** `packages/bots` is triggers, tools, budget arithmetic and
   one turn over a `BotHost` interface the api implements — no database, no network of its own, no
   credential, and no import of anything but `@perch/db`'s types and the AI SDK.
10. **A bot's turn never happens inside the request that caused it.** The bus subscriber starts the
    run and returns; whoever posted the message gets their 201 immediately.
11. **Recall without an embedding model falls back to the words.** `bot_memories.embedding` is
    nullable and the HNSW index is partial: a Perch with no embedding model configured still keeps
    and finds what a bot remembered, by `ilike` over the content, rather than pretending to a vector
    it never computed.

### A note on shutdown
`BotsService.settled()` waits for whatever a bot is in the middle of saying, and the obvious place
to call it is `boot`'s `close()`. It was not called there: adding **any** extra `await` to `close()`
— `await Promise.resolve()` was enough, at any position — made `apps/api/test/preview-tunnel.test.ts`
spin at 100% CPU during teardown, and that reproduced on `main` without a line of task 2.6 in the
tree. So the spin was a latent bug in the shutdown path rather than something bots introduced.

**Fixed in ADR-0109**, and the drain is now in `close()`: a run in flight finishes instead of being
abandoned with its `bot_runs` row left `running`.

### Consequences
A workspace can have bots that answer, on any provider somebody has a key for or on a local model,
with what each one costs visible per turn. The Bot API seam from 2.5 now has a runtime beside it for
2.7's transports to attach to.

What is not here: the Forge UI (2.8), spec and code bots and the QuickJS sandbox, the Bot API's own
routes and tokens (`chat.postMessage` and friends), bot-to-bot mentions and chains (2.7), DM-a-bot
(2.9), `sandbox_exec`, `repo_read`/`repo_search`, `open_session`, `image_generate` and MCP attach,
per-install tool narrowing beyond the spec's own list, and typing indicators while a bot thinks.

**Spec deviation.** §7.7's catalog has `bot.installed|uninstalled|run_*` but no event for a bot
being created, changed or deleted, and the catalog is closed (a test asserts it is exactly the
spec's list). So bot CRUD publishes nothing and is therefore not in the audit log; when the spec
grows `bot.created`/`bot.updated`, the publish plugs into the same places.

### What was actually verified
`apps/api/test/bots.test.ts` against a stub OpenAI-compatible endpoint (the whole lane: credential in
the vault → gateway → streamed answer): a bot made, refused a taken handle, installed and a member of
the channel; **the acceptance** — a mention answered in the thread, by name, badged, with no
"(edited)", and a `bot_runs` row carrying the model, 120 input and 30 output tokens; the channel's
flow left alone; the model shown the conversation with people's names; silence when nobody named it;
the test chat answering without posting; a rate limit refusing the next run and saying so where it
was asked; a scheduled trigger keyed in the queue and firing into the channel it names; a private
bot invisible to the workspace's owner; and a member refused a workspace-visible bot. Plus the
guards: `fetchable` refusing loopback, private, link-local, `::1`, `file:` and nonsense, and
`readable` stripping scripts.
`packages/bots/test/runtime.test.ts` and `triggers.test.ts` (ADR-0095's commit and this one): the
placeholder, the cost, the budget, the wrapper, and every trigger.
`e2e/bots.e2e.ts` at both viewports: a brain and a bot made over the routes the Forge will use, a
mention in the composer, the answer arriving in the thread with the BOT badge, axe clean, and the
run on the ledger.

## ADR-0097: A tag is a hop, and hops are counted

- Status: accepted
- Date: 2026-09-15
- Task: 2.7

### Context
§5.4 makes a mention the way bots work together and then spends most of its length on what stops that
going wrong: a hop limit, no self-mention, repeat-pair detection, a per-thread budget, a breaker that
pauses the thread and asks a person, and `/stop`. Task 2.6 already made a bot answer a mention, and
nothing in it distinguished a person's mention from another bot's — which is exactly the loop §5.4 is
about.

### Decision
1. **One enforcement point.** A tag arrives as an ordinary message either way — a bot calling the
   `mention` tool posts one, and a bot that simply writes `<@gamma>` in its reply has tagged them
   too. So the rails live where a trigger is matched (`offer`), not in the tool: whatever route a
   mention took, it is counted, paired and paid for the same way.
2. **A bot's reply is offered when it is finished.** A reply reaches people by editing the
   placeholder, so its words never travel on `message.created`. The finished text is handed to the
   other bots explicitly, once — which also means a streaming edit can never set anything off.
3. **The rails are arithmetic over the hops so far** (`packages/bots/src/chains.ts`), so the rule can
   be read and tested without a database: bot-to-bot hops are what the limit counts, a person's
   mention is not one, and A → B → A → B trips on the third leg while A → B → C does not.
4. **The thread's budget is the starting bot's** `budget.perThreadUsd`, spent across every hop —
   which is §5.4's "inherited from the root and split across hops" without inventing a second ledger:
   each hop's cost is on its own `bot_chains` row.
5. **The breaker pauses the thread in the thread's own state.** `chain.stopped` and `chain.breaker`
   are thread facts (§5.4's "shared state: the thread + thread_facts"), so pausing needs no new table
   and a client can see why. A fact is never written as null — the column is json and not-null — so
   clearing one writes an empty string.
6. **The intervene card is an interactive block** (task 2.5): an `approve_deny` whose id carries the
   thread, answered through the route that already exists, and heard on the Bot API seam that already
   exists. Continue clears the pause; Stop leaves it. The inbox copy of that card is task 2.10.
7. **`/stop` and `/resume` are ordinary messages** a person writes, not a control channel: the
   message stands as the record of who called it, and the bots read the fact it sets.
8. **A tag's mode is remembered beside the message it travels on** (consult, handoff, fanout), in
   process, until the hop it causes is recorded. A mention is a message, and a message has nowhere
   to carry a mode; the alternative — a marker in the text — would be visible to everybody reading
   the channel.

### Consequences
Bots can work together in a thread and a person can see what that cost, stop it, or let it go on.
The rails are the same whether a bot was tagged by a person, by another bot's tool call, or by
another bot's prose.

What is not here: an orchestrator flag that lets some bots skip the untrusted wrapper ("unless from a
trusted orchestrator"), group handles (`@newsroom-crew`), task cards for a hand-off (work items are
Phase 3), `policy.yaml` deciding who may tag whom and whether bot-to-bot DMs are allowed (the policy
engine is 2.11 — until then the defaults are the code's), the inbox's copy of the intervene card
(2.10), and typing indicators.

### What was actually verified
`packages/bots/test/chains.test.ts`: a person's tag is not a hop and the first bot-to-bot one is; a
bot never answers itself; six hops by default and two when the spec says two; A → B → A → B tripping
while A → B → C and A → B → A → B → C do not; the budget spent across hops with what is left
reported; and the summary a header shows.
`apps/api/test/chains.test.ts` against the stub provider — **the acceptance**: three bots complete a
fan-out (the lead tags two, both answer, and all three hops are on the chain with their costs), and a
ping-pong pair trips the breaker (the thread pauses, the intervene card is posted, nothing more
happens while it is paused, Continue lets them go on again, and they answer). Plus `/stop` halting a
thread outright and `/resume` letting it carry on.
`packages/ui/src/components/chain-header.ct.tsx` and `packages/ui/test/chain-header.test.ts`: the
header's hops, bots, money and paused state, axe clean, and nothing at all when nothing has happened.
`e2e/chains.e2e.ts` at both viewports: a person asks the lead, the lead tags the desk, the desk
answers, and the thread's header counts two hops with both bots named.

## ADR-0098: A template is a filled-in form, not a bot

- Status: accepted
- Date: 2026-09-15
- Task: 2.8

### Context
§5.3 gives the Forge "form + live test chat + templates" and names six of them. The obvious way to
ship templates is to have the api create a bot from a template id — one click, a bot exists. The
other way is to have the template fill the form in and let the person press Create.

### Decision
1. **A template fills the form in.** `BOT_TEMPLATES` is data; picking one writes a draft into the
   form, and the ordinary `POST …/bots` creates whatever the person ends up with. Nobody gets a bot
   they have not read, the handle can be changed before it is taken, and there is no second creation
   path in the api to keep in step with the first.
2. **The templates live in `@perch/bots/templates`, a module with no imports.** The Forge runs in a
   browser and the bot runtime must not: a subpath of plain data keeps the AI SDK, the tools and the
   host out of the web bundle while the list stays in the package it belongs to.
3. **The Forge is a section of workspace settings**, beside Brains and Connections, rather than a
   seventh rail mode. A bot is configuration of the workspace in the same sense a brain is, and §4's
   rail has its six modes.
4. **The test chat is the ordinary run with nowhere to post it** (`quiet`), so what a person tries in
   the Forge is exactly what a channel would get, ledger row and all.
5. **Skills are part of the spec, not files yet.** §5.3's `skills/` in the Agent Skills format
   arrives here as `spec.skills` — name, description, instructions — put in front of the model with
   the persona. The directory form belongs with spec bots (`bot.yaml` + `skills/`), which is a later
   task; the shape is the same one, so those files will parse into this field.

### Consequences
Six good starting points, and a bot that is always something the person chose. The templates are
a list anybody can extend without touching the api.

What is not here: editing a bot's spec after it exists (the form creates; the card pauses, installs
and tries), the live test chat as a conversation rather than one question, spec bots and code bots,
and per-install tool narrowing in the UI.

### What was actually verified
`packages/bots/test/templates.test.ts`: the six the spec names, unique handles, every template
parsing as a bot spec the api would take, only tools that exist, and the newsroom's schedule saying
when and where. `packages/bots/test/runtime.test.ts`: a bot's skills in its prompt, and a skill with
no instructions left out. `e2e/forge.e2e.ts` at both viewports — **the acceptance**: Grok Newsroom
picked from a template, the form filled in from it, created against the workspace's brain, put in
#general, tried in the Forge's test chat, and then answering `@grok` in the channel with its BOT
badge; axe clean on the Forge.

## ADR-0099: A chat with a bot is a room of threads

- Status: accepted
- Date: 2026-09-15
- Task: 2.9

### Context
§5.2 asks for "DM-a-bot: 'New chat' starts a fresh thread; model picker per DM when the bot allows".
Two things have to be decided: what a chat *is*, and where the picked model is kept.

### Decision
1. **A chat with a bot is an ordinary DM, and every chat in it is a thread.** Opening it makes a
   `dm` channel with the person and the bot in it, one per pair, found rather than remade the second
   time. "New chat" is not a new room and not a new column anywhere: it is simply nothing selected,
   so the next message is a root and the chat hangs off it. A room of threads means the search,
   read state, pins and everything else already written work on chats as they are.
2. **A bot sees the conversation it is in.** Asked in a thread, that is the thread — its root and
   the replies under it, which also fixes a bot answering in a channel thread having never been
   shown the message that started it. Asked in a room, it is the room's recent flow, as before. A
   chat is always a thread, so a new chat starts the bot on what is said in it and nothing else.
   This is what "fresh context per thread" means, and it needs no new memory setting.
3. **The picked brain is kept on the install** (`bot_installs.scopes.brain`), not on the bot and not
   on the person. A DM is one person's room, so per room *is* per person there; and the same field
   will carry a channel pinned to a local model when the policy engine (2.11) wants one, rather
   than a second mechanism for the same idea.
4. **A bot has to offer the choice.** `spec.brain.pick` makes the picker appear; without it the api
   refuses with a conflict rather than ignoring the ask. A bot's maker decides whether its answers
   may come from somewhere else, which matters when the persona was written for one model.
5. **The bot's reply always hangs off what it answers**, in a DM as in a channel. It was the only
   way to make chats hold together, and it costs nothing elsewhere: a room already threaded them.

### Consequences
No migration: the room is a channel, the chat is a thread, the choice is a scope. `New chat` is
free, and a chat can be reopened from the picker with its own context intact. The cost is that a
person cannot talk to a bot in a flat, unthreaded DM any more — every exchange belongs to a chat —
which is the shape §5.2 asks for. Group DMs with a bot in them behave the same way.

## ADR-0100: An inbox item says what it is, rather than being looked up

- Status: accepted
- Date: 2026-09-15
- Task: 2.10

### Context
§6 gives `inbox_items` its columns: workspace, user, kind, ref_type, ref_id, status, snoozed_until,
resolved_at. Nothing in that row says what the item is *about*, so rendering a queue of twenty means
twenty lookups across five services — a session's pending permission, a message and its channel, a
thread's chain, a bot and its ledger — each of which has to exist and be readable at that moment.

### Decision
1. **One added column: `payload` jsonb**, holding the title, the body and the path the item points
   at, written by the subscriber when the item is made. A spec deviation, and the only one here:
   `notifications.payload` already works this way, and it is what makes a queue one query and a
   phone's launch tab cheap enough to ask for on every start.
2. **A unique index on (user, kind, ref_type, ref_id)**, also not in §6. It is what makes the
   subscriber idempotent: an event delivered twice is one row, and a thing that needs a person again
   after being resolved re-opens the row it already had rather than piling up duplicates.
3. **The inbox is read-only about the world.** Resolving an item puts the row away; it never acts on
   what the row points at. The one exception is by design and lives in the client: Approve and Deny
   on a permission call the session's own endpoint, and the item then resolves itself off
   `session.permission_answered`. So there is one place that answers permissions, and the inbox is a
   second way to reach it rather than a second implementation of it.
4. **`ref_id` is text, not a uuid.** An engine's permission id is its own string (§7.6), so a
   permission item points at `<session>:<permission>` and the client splits it.
5. **A snooze is resolved on read.** `status=open` includes a snoozed item whose moment has passed,
   so nothing has to sweep the table on a timer for a phone to show the right count.

### Consequences
A queue renders in one query and says the same thing the push notification said. What an item says
is what was true when it arrived — a permission whose tool was renamed still reads as it did — which
is right for a record of "this needed you", and is why the row also carries the path to the live
thing. Migration 0018 adds the table.

## ADR-0101: The policy is evaluated where the context is, and the runner keeps its floor

- Status: accepted
- Date: 2026-09-15
- Task: 2.11

### Context
§5.7 puts `.perch/policy.yaml` at workspace and project level and lists rules that live in very
different places: branches and commands belong to a runner, models and budgets to the api, bot rails
to a thread. Task 1.5 already gave every runner fs/git/exec method a policy hook (ADR-0070) with a
built-in floor. The question is where the *document* is read and who asks it.

### Decision
1. **`@perch/policy` owns what a document means** — the schema, the merge, and `evaluate(policy,
   request)` — and knows nothing about databases, runners or HTTP. One evaluator, so the dry run and
   every enforcement point cannot drift apart.
2. **The api evaluates; the runner keeps its floor.** The api has the workspace, the channel, the
   project and the model to hand, so that is where the document is read and enforced. A runner goes
   on refusing what it always refused, whatever the document says, so a policy can only tighten what
   an agent may do. Pushing the document down the §7.6 protocol — so a runner enforces the same
   `commands.deny` inside a session's own tool calls — is a later task, and is why `commands.deny`
   is answered by the dry run today rather than at a second enforcement point.
3. **A later layer narrows and never widens.** Lists join, allow-lists shrink, ceilings take the
   lower number, and a switch that is off by default cannot be turned on further down. A project can
   tighten what it inherits; that is the whole point of having two levels.
4. **A document that will not parse is an empty policy, not a locked door.** A broken file must not
   take the workspace down; writing one through the api is refused (422) so it cannot get there
   quietly, and a file that arrives another way simply does not apply.
5. **The documents live in §6's `policies` table**, one row per workspace and one per project that
   has its own, with `rules` holding what the document parsed to and `version`/`updated_by` saying
   which change this is and who made it. One column is added to that table — `yaml`, the document as
   it was written — because what comes back has to be what somebody typed, for a file people are
   meant to read and check in. The parsed form is cached for five seconds so a busy channel does not
   re-read it per message.

   *Corrected after the fact:* this first shipped as `policy_yaml` columns on `workspaces` and
   `projects` (migration 0019), which is not what §6 says, and the commit that did it wrongly
   claimed no spec deviation. Migration 0020 moves the documents to the `policies` table and drops
   those columns; the one remaining deviation is the added `yaml` column, recorded here.
6. **A refusal is a 451 and a `policy.violation`.** One shape everywhere: the error says which rule,
   the event is what the audit log and any card are built from, and a bot refused in a channel says
   so in the thread rather than going quiet.

### Consequences
The acceptance holds at both ends: a channel pinned to local models refuses a cloud profile before
the model is ever built, and `git push --force` comes back refused from the same evaluator that the
runner's floor refuses it with. What is not yet enforced at a second point — `commands.deny` and
`paths.*` inside a running session — is the runner's floor today and named as such here, rather than
quietly missing.

## ADR-0102: Secrets are looked for in what a commit is about to take, not in the working tree

- Status: accepted
- Date: 2026-09-15
- Task: 2.12

### Context
§5.7 asks for "secret scanning on every agent diff before commit". A scanner can run in many
places — a file save, a diff apply, a commit, a push — and each catches a different set of
mistakes at a different cost.

### Decision
1. **The gate is the commit.** A key in a file somebody is still editing is a draft; a key in a
   commit is in history, and history is the one place it cannot be taken out of. So `POST
   .../git/commit` reads what it is about to take and refuses before the runner is asked. Saving a
   file stays fast and quiet, which is what makes the gate bearable.
2. **What it reads is the whole change, not `git diff`.** `git diff` knows about files git already
   knows about, and the file an agent has just written is untracked — exactly the case that
   matters. The api asks for the status too and reads each untracked file the commit would take (up
   to 200 files, skipping binaries and anything over 512 KB), so the scanner sees it as the new
   file it is.
3. **Findings carry a mask, never the value.** `sample` is the first and last four characters. A
   card that repeats a key to warn about it has leaked it a second time, into a screenshot, a log,
   or a bug report.
4. **Lines being removed are not findings.** Taking a key *out* is the thing we want to encourage.
5. **The rules are prefix-first.** A provider's own prefix (`ghp_`, `sk-ant-`, `AKIA`) is the
   strongest signal there is; the one shape without a prefix — a name that says secret beside a long
   value — is the only rule likely to be wrong about a repository, and is the one `allowRules` is
   for. Placeholders and example files are skipped, because a scanner people learn to click past is
   worse than none.
6. **It is part of the policy document.** `secrets.scan`, `secrets.ignorePaths` and
   `secrets.allowRules` live beside the other rules (ADR-0101), so a project can name its own
   fixture directories and only a workspace can turn scanning off.

### Consequences
A planted key blocks the commit with a card at both viewports, and the same commit goes through once
the key is out. The cost is one extra `git.diff`, one `git.status` and a read per new file on every
commit; the scan itself is a few regular expressions over the added lines. What this does not catch
is a key committed from a terminal inside the runner, which is the shell's own business (ADR-0101).

## ADR-0103: A project's environment is write-only, and the transcript is redacted

- Status: accepted
- Date: 2026-09-15
- Task: 2.13

### Context
§5.7 asks for an encrypted per-project env, "injected into runner, previews, sessions; never into a
model context". The second half is the hard one: a session runs with the values, an agent can print
them, and the transcript is both a record people read and something a model is shown later.

### Decision
1. **Values never come back over the wire.** `GET .../env` answers with keys, sources and when each
   was set. There is no route that returns a value, so there is nothing to leak through the api,
   the SDK, a screenshot or a log line. Each value is sealed under `project-env:<project>:<key>`, so
   a ciphertext is bound to the row it belongs to.
2. **The transcript is redacted at the one place every event passes.** `SessionService.record()`
   replaces any of the project's values with `[redacted: NAME]` before the event is persisted or
   fanned out, walking the whole event rather than a known field, because a value can arrive in a
   tool's arguments as easily as in text. The engine still runs with the real values; only the
   record is cleaned.
3. **A session's secrets are read once, when its engine is made** — which is before any event of
   that round can arrive — and cached for the life of the process. Re-reading per event would mean
   a decrypt per token of streamed text.
4. **Values under six characters are not redacted.** A three-character value turns a transcript into
   noise, and a secret that short is not one.
5. **`pty.open` takes an `env`** (additive to §7.6, like ADR-0073's `pty_id` and ADR-0083's
   `mcp_servers`), so a terminal — and the dev server somebody starts in it, which is what a preview
   proxies — has the project's environment. `PERCH_*` names are never taken from a project.
6. **The model's credential wins.** The project's environment goes in first and the model profile's
   own credential on top, so a project variable cannot stand in for a provider key (AGENTS.md §1.6).

### Consequences
The acceptance is provable rather than asserted: the fixture agent is asked to print `DATABASE_URL`,
answers with the value, and the transcript says `[redacted: DATABASE_URL]`. What this does not cover
is a value the agent transforms before printing — base64, or a string it assembles — which no
redactor can catch; the answer to that is the same as everywhere else, that an agent is given what
it needs and nothing more.

## ADR-0104: The app-js budget grows with the app; the initial one does not

- Status: accepted
- Date: 2026-09-15
- Task: 2.14

### Context
`scripts/perf-budget.ts` has guarded three numbers since task 0.12: the bytes `index.html` pulls
before anything renders, the app's own JavaScript across every route chunk, and the library packs a
route loads on its own. Phase 2 has added the Forge, chats with bots, the inbox, the policy editor,
the environment card and the grants UI; app-js has crept from 480 KB to 519 KB of a 520 KB budget,
and every remaining Phase 2 task adds a screen.

### Decision
Raise `appJsGzipKb` to 600 and leave `initialGzipKb` at 180 and `packsJsGzipKb` at 480.

What a person waits for before the app is usable is the entry chunk and its stylesheet; that is
what 180 KB guards, and it has not moved (179.5 KB) through all of Phase 2 because every screen's
strings and components sit behind its own chunk (ADR-0085, ADR-0072). App-js is the sum of all
those chunks: it says how much there is to download *eventually*, spread across the screens somebody
actually opens. Holding that sum flat while the product grows would mean either refusing screens or
gaming the split, and neither makes anything faster.

### Consequences
The budget that matters still fails a change that puts bytes in front of the first paint. The app-js
number goes on being measured and reported on every run, so a jump is visible; it is now a number
that can grow with the screen count rather than a wall Phase 2 was about to hit for the wrong
reason. If a single route ever needs its own ceiling, that is a per-chunk budget to add, not a
smaller total.

## ADR-0105: A connection is discovered at the moment of connecting, and lent only on its owner's behalf

- Status: accepted
- Date: 2026-09-15
- Task: 2.14

### Context
Spec §3.5 names four ways Perch can be a client of somebody else's OAuth server — an app registered
here, this instance's client metadata document (CIMD), dynamic client registration (RFC 7591), and
a pasted token — and says MCP OAuth is discovered "RFC 9728 → RFC 8414/OIDC metadata → PKCE". It
does not say when any of that happens, nor what happens when a connection that belongs to one person
is handed to a bot the whole workspace can talk to.

Both questions have an easy wrong answer. Discovery could be a field in the manifest: write
Supabase's authorization server into `connectors/supabase/manifest.yaml` and skip two round-trips.
And a grant could be a plain row: this bot may use this connection, the way a permission usually is.

### Decision

**Discovery happens when somebody clicks Connect, never in a manifest.** A manifest says only where
the MCP server is (`mcp_url`) — everything downstream of that is asked for, in order, at that
moment: the protected-resource document, then the authorization server's metadata, then who Perch
is as a client. The lane that answered is stored on the connection for the card to show, but it is
an observation, not configuration.

**The client lanes are tried strongest first**: an app somebody registered in this workspace, then
CIMD when the server advertises `client_id_metadata_document_supported`, then registration on the
spot, then nothing — which leaves the paste lane, which every provider always has.

**A grant carries an on-behalf-of flag, and the personal-to-shared case may only be taken that
way.** Granting a personal connection to a workspace-visible bot without the flag is a 403 with the
rule named; with it, the gateway refuses at use time whenever the person who set the bot running is
not the connection's owner. The check is at both ends deliberately: the grant so nobody is surprised
later, the use so a grant made before a bot became shared cannot be a back door.

### Consequences
Connecting costs two or three extra HTTP round-trips, and a provider that changes its authorization
server needs no release here — which is the trade this way round. A provider whose MCP server is
unreachable cannot be connected on that lane at all; the card says so and the paste lane is still
there.

`mcp_url` on a connection is an override in the same shape as `api_base`, so a self-hosted Supabase
or an enterprise Clerk is reached without a second connector. The e2e runs the whole round-trip —
discovery, RFC 7591 registration, PKCE, the code exchange — against a stand-in MCP server started by
`scripts/e2e-server.ts` (`apps/api/test/fixtures/mcp-server.ts`), so the protocol is exercised for
real on a machine with no internet, rather than mocked inside Perch.

The on-behalf-of rule makes "ask the shared bot to do it" stop being a way to borrow somebody's
login. It also means a shared bot cannot do anything on a personal connection while its owner is
asleep, which is the point: anything that has to run unattended is connected on the workspace's
behalf, on an API key or a local model (AGENTS.md §1.6).

### Spec deviations
None. `/connections` — where a provider's callback lands — is not in §7.1's route list because it is
a page, not an endpoint: the api redirects there, the browser resolves which workspace it belongs to
and carries the outcome to that workspace's Connections card.

## ADR-0106: A deploy's card is the deploy; the database panel is the MCP gateway

- Status: accepted
- Date: 2026-09-15
- Task: 2.15

### Context
Spec §5.5 asks for a Deploy button with "preview-URL cards" and for Supabase's "schema/table browser
in the panel, SQL with permission prompt for writes". §11's acceptance is "a Vercel deploy posts its
preview URL in a thread". Neither §6 nor §7.1 has anything for either: no `deployments` table, no
deploy route, no database route.

Two obvious designs were available and both are worse than what landed.

A `deployments` table with rows the IDE lists, and a card posted beside it. That is two records of
one thing, and they drift: the row says `ready` and the card in the thread still says `building`,
because the card was a notification rather than the thing itself.

A database panel on each vendor's REST API — Supabase's Management API, then Neon's, then
Planetscale's. That is a release per provider, and a second place where a credential is used.

### Decision

**The card is the deploy.** `POST .../projects/{p}/deploys` asks the provider to build and posts one
message carrying a `deploy_card` block: the provider, its deployment id, the target, the branch, the
state, and the URL once there is one. `POST .../deploys/refresh` asks the provider again and
rewrites that same block in place, with no edit history, because a build moving is not an edit
somebody made. The IDE panel polls while the build runs, so the thread fills itself in whether or
not anybody is watching the panel. Nothing is stored anywhere else, so nothing can disagree.

**The database panel is the MCP gateway with two tool names off the manifest.** A connector that has
a database carries a `db` block — `tables_tool`, `query_tool` and the argument names — and the panel
calls those through `/mcp` (task 1.17), which already attaches the connection's own token, filters
by allow-list, and audits every call. Adding a second database provider is a YAML file.

**Read-only is Perch's rule, checked here.** One statement, starting with a read, with no
data-modifying word anywhere in it — so a write cannot hide in a CTE or behind a comment. A refusal
is a 451 naming `db.read_only`, and the provider is never touched. Trusting a server's own read-only
mode would be trusting a promise somebody else made.

### Consequences
A deploy older than its channel's retention is gone with the message, which is the right trade for a
build URL: the deployment still exists at the provider, and the card links to its build page. There
is no "all deploys for this project" list; the channel is that list, searchable like everything else
in it.

Polling is the IDE's, not the server's: close the tab mid-build and the card stays at *Building*
until somebody presses **Check again** — a deploy webhook (spec §5.5's "build/runtime logs → thread")
is what fixes that, and it is Phase 3's.

The blunt read-only test refuses some legitimate SELECTs. It is easy to loosen later and impossible
to un-drop a table, so it starts strict and says why.

### Spec deviations
Three, all additive.

- **`deploy_card`** joins the §6 message-block union. The interactive blocks of §5.2 are unchanged;
  this is a card the app draws, like `diff_card` and `session_card` before it.
- **`deploy.started`** joins the §7.7 bus catalog, the way `session.turn` and `session.status` did
  (ADR-0074). It carries the project, the provider, the deployment, and the message its card is in.
- **Five routes** beyond §7.1: `POST .../projects/{p}/deploys`, `POST .../projects/{p}/deploys/refresh`,
  `GET .../connections/{id}/db/tables`, `POST .../connections/{id}/db/query`, and
  `PATCH .../projects/{p}`. §7.1 lists no route for either feature while §5.5 asks for both; these
  are the smallest surface that does what §5.5 says. The PATCH is the one that is not about a
  provider: a project's repository could only be set by cloning, so a project created empty and
  pushed somewhere later could never deploy. It takes a name, a default branch, and a repository URL
  — the plain fields §6 already gives `projects` — and the Deploy panel asks for the URL rather than
  refusing.

No table was added, so there is no migration and §6 is untouched.

## ADR-0107: The source tag is scanned, not parsed, and the plugins depend on nothing

- Status: accepted
- Date: 2026-09-15
- Task: 2.16

### Context
Spec §5.6 asks for "@perch/inspector dev plugin (Vite, Next, Nuxt, Astro, Webpack/Rspack, SvelteKit,
Solid; wraps the code-inspector-plugin approach) tagging `data-perch-src="src/components/Button.tsx:42:7"`".

The obvious way to do that is to parse each file — Babel or SWC — walk the JSX, and add an
attribute. It is also the way that puts a second JavaScript toolchain into every project that wants
the inspector, with its own version to keep in step with the project's own.

### Decision
`tagSource` is a scanner. It walks the file once, tracking strings, template literals and comments,
and when it finds a `<` that opens a tag it recognises — a component, a dotted name, or a known HTML
element — it inserts one attribute after the tag name. Anything it is not sure about is left exactly
as it was.

The plugins are plain objects with the hooks each tool calls. `@perch/inspector` imports nothing but
`node:path`, so adding it to a project adds a transform and not a toolchain.

### Consequences
Some elements are missed: a component behind a computed name, JSX inside an unusual macro. A missed
tag costs the inspector one source link and the agent one search; a tag written into a string would
cost a build. The failure mode is the right way round, and the unit tests pin it there.

`a < b` is not mistaken for an element because a lowercase name has to be a real HTML tag, and a
capitalised one has to be followed by something that closes like a tag. Everything the scanner
refuses to touch is still inspectable — the client falls back to describing the element by its place
in the DOM, which is what §5.6's "fallbacks" are.

If a project ever needs perfect coverage, a parser-backed plugin can be added beside this one
without changing anything downstream: the attribute is the contract.

## ADR-0108: A screenshot is the runner's own browser, asked directly

- Status: accepted
- Date: 2026-09-15
- Task: 2.16

### Context
Spec §5.6 asks for "Screenshot via headless Chromium in the runner → attach to prompt or post to
thread", and §5.6 later attaches `@playwright/mcp` to sessions for the agent's own eyes. §7.6 has no
method for either.

### Decision
`preview.screenshot` is added to the §7.6 protocol — additive, like `project.setup` (ADR-0069) and
`git.apply` (ADR-0079) — and the runner answers it by running the headless browser it already has:
`--headless --screenshot`, a window size, and a URL. No library, no driver, no second dependency.

What comes back is a PNG in base64, which the api stores as an ordinary file. From there it is
either a context chip on the next turn or a message in a channel, which is the difference between
"look at this" and "everyone should see this".

Which browser is an environment question: `PERCH_CHROMIUM`, then the one Playwright installed, then
the usual system paths. A runner with none says so in a sentence that names the fix.

### Consequences
A screenshot is a page as a browser renders it with no scripting of its own — no clicking, no
waiting for a selector. That is all §5.6 asks of this one; the scripted kind arrives with
`@playwright/mcp` in Phase 3, and it will want the driver, not this.

The runner image installs a browser for that Phase 3 work anyway, so this costs nothing there. A
local runner on a laptop almost certainly has Chrome or Chromium; when it does not, the button says
what to install rather than pretending.

### Spec deviations
`preview.screenshot` (§7.6), and `POST /api/workspaces/{ws}/projects/{p}/screenshot` (§7.1 lists no
route for a feature §5.6 asks for). Both are the smallest surface that does what §5.6 says.

## ADR-0109: A closing database drains what it started and refuses what comes after

- Status: accepted
- Date: 2026-09-15
- Task: the shutdown race (the follow-up ADR-0096's "note on shutdown" left open)

### Context
`Booted.close()` could not be given one more `await`. Adding `await Promise.resolve()` anywhere in
it — before the first line, before the last — made `apps/api/test/preview-tunnel.test.ts` pin a core
and grow to about 4 GB instead of finishing. Nothing in the function looked like a loop.

What the extra tick changed is what had *started* by the time `db.close()` ran. Perch's real
shutdowns already yield: `apps/api/src/index.ts` and `apps/cli/src/laptop.ts` both await the queue
worker before closing, and `RunningServer.stop()` force-closes every socket first. A socket closing
is not quiet — the runner channel's `onClose` marks that runner offline, and it does so
fire-and-forget, because a WebSocket callback cannot be awaited by whoever closed the socket. One
extra tick was enough for that write to be in flight when PGlite was told to close.

And PGlite closing with a query in flight does not fail — it spins. Inside its own
`execProtocolRawSync` is a `for (;;)` that runs `_PostgresMainLoopOnce()` until the input buffer is
consumed, with the error from each iteration swallowed. When the connection is already tearing down
that condition is never met, so the loop runs for ever, allocating as it goes. That is the core at
100% and the 4 GB.

### Decision
Two changes, at two levels, because the cause has two halves.

**The database handle is made ordering-insensitive.** `createDb`'s PGlite handle counts the queries
it has started. `close()` waits for those to finish (up to `PGLITE_DRAIN_MS`, five seconds), then
refuses anything that arrives afterwards with "the database is closing; this query was not run",
then closes. A stray write during teardown is now a rejected promise with a sentence in it, rather
than a wedged process. This is the half that matters, because Perch cannot promise that nothing
anywhere ever starts a write while shutting down: a socket closing, a subscriber finishing, a
`.catch()` on a background job are all ordinary.

**The runner channel stops losing the write.** `close()` now tears each session down itself, awaited,
rather than closing the socket and hoping its `onClose` runs in time; and it drains any teardown a
socket already started on its own. So a shutdown leaves runners `offline` in the database, which is
what somebody sees after a restart.

With those, `close()` gained the `await bots.settled()` that task 2.6 wanted and could not have: a
bot's in-flight run finishes instead of being abandoned with its `bot_runs` row stuck on `running`.

### Consequences
`apps/api/test/shutdown.test.ts` holds the property rather than the ordering: an app closes after
its sockets were killed and a tick passed; it closes with a query in flight and that query still
gets its answer; a query issued after closing is refused; and a shutdown really does mark its
runners offline. The extra tick is in those tests on purpose — it is the thing that used to break.

A close now takes as long as the work it is waiting for, which for Perch is milliseconds. The
five-second cap means a genuinely wedged query delays a shutdown by five seconds and no more; after
that the close proceeds, which can still meet PGlite's spin — a cap is a bound on waiting, not a fix
for a query that never ends.

Postgres is untouched: `postgres.js` closes its pool with its own timeout and has never had this
problem. The guard is PGlite's because the bug is.

## ADR-0110: An index nobody has to pay for, and context that rides beside the turn

- Status: accepted
- Date: 2026-09-15
- Task: 2.17

### Context
Spec §5.7 asks for a "codebase index (symbols + embeddings in pgvector) behind @codebase; semantic
search across code, chat, docs; generated repo docs and an AGENTS.md draft", and §11's acceptance is
"an @codebase question cites the right file". §6 fixes the table — `repo_index: project_id,
commit_sha, path, chunk_no int, kind check in (symbol, chunk, doc), symbol?, content, embedding
vector(1024), text_search tsvector generated, unique(project_id, path, chunk_no, commit_sha),
hnsw(embedding), gin(text_search)` — and it is implemented exactly, plus `start_line` and `end_line`
so a hit can cite `path:line` rather than a file, which is what "cites the right file" is worth
having. §7.1 has no route for any of this, so the endpoints, the job, and the shape of the context
were this task's to choose.

Three choices needed making, and each had an obvious answer that is wrong.

**Embeddings could have been required.** pgvector is already there for `bot_memories`, so the
straight reading of "symbols + embeddings" is that a project is indexed once a workspace has an
embedding model and not before. But Perch is self-hosted and open source: an instance with no
provider key and no Ollama is the normal first hour, not an edge case. An index that refuses to
exist until somebody has paid for a model would make `@codebase` a feature of installs with
credentials, which is the opposite of what this project is.

**The context could have been written into the turn.** `withCodebaseContext` did exactly that at
first: rewrite `body.text` in the route, and everything downstream carries it. It works, and it puts
twelve thousand characters of somebody else's code into the transcript under the person's name.

**The index could have been a fresh read of the repository each time.** Simpler — no table, no
staleness. Also ten seconds a question on a real repository, and no vectors at all.

### Decision
**The embedding is optional and named, not assumed.** `repo_index.embedding` is
`vector(1024)` and nullable. Every chunk gets a row and a generated tsvector; a chunk gets a vector
only when the workspace has a model profile whose `default_for` is the new `"embedding"` — a third
value beside `chat` and `code`. A search asks the words always and the meaning only when there are
vectors, and merges the two lists with reciprocal rank fusion (k=60), which needs no shared scale
between "how well the words matched" and "how near the vectors are". A provider that refuses does
not fail the pass: the rows go in without vectors and `embedding_skipped` says why. So a Perch with
no brains still has a codebase index, and `@codebase` still cites the right file — which is the
acceptance, met without a credential.

1024 is the spec's number, not a choice — but living with it is. Providers return whatever width
their model has, so `fit()` in `packages/gateway/src/embeddings.ts` folds a longer vector and pads a
shorter one, then L2-normalises, and `dimensions: 1024` is asked for in the request as well for the
providers that honour it. Folding loses information; being unable to use a provider's model at all,
or having to migrate a column to change models, loses more.

**The context rides beside the turn, not inside it.** `codebaseContextFor` returns the block;
`SessionService.sendTurn` takes it as `options.context`, records the turn as the person typed it,
and prepends the context only on the way to the engine. The transcript is what a person said; the
model gets what it needs. Nothing about `UserTurn` or the §7.6 runner protocol changes — the engine
seam never learns that `@codebase` exists.

**The index is rows, rebuilt on a job.** `POST .../projects/{p}/index` queues a pass on the new
`repo-index` queue and `project.updated` says when it landed; `wait: true` runs it inline for
scripts and for the panel's Index now. A pass writes every chunk for the current commit before
dropping the other commits' rows, so a search during a reindex finds the old answer rather than
none. Chunking is `@perch/repo`: a symbol chunk per declaration found by the shape its language
declares things in, a 60-line window with 10 lines of overlap for everything else, and Markdown cut
at its headings — no parser, the same trade ADR-0107 makes for the inspector's source tag.

### Consequences
A workspace names its embedding brain the same way it names its chat and code brains, so
`PROFILE_DEFAULTS` is now `["chat", "code", "embedding"]` and the make-default route takes all
three. That is a widened check constraint, in migration `0021_repo_index.sql` along with the table.

The code lane joins the existing search box rather than getting a page: `GET .../search?type=code`
searches every project of the workspace the caller can see, and the page links each hit to
`/$workspace/code/$project?file=…&line=…`, which is a deep link the editor route now honours for
anything that wants to point at a place in a file. That lane is the words only — a box that fires as
you type should not call an embedding provider on every pause, and it spans projects that need not
share an embedding model. The meaning is asked of one project at a time: the panel, or `@codebase`.

A 3,000-file cap and a 400 KB per-file cap bound a pass. A repository past the cap indexes its
shallowest files first — breadth-first — because those are what an answer is most often about. A
`node_modules`, a lockfile, and a build directory are never read at all.

`@codebase` is only ever as fresh as the last pass. Perch does not watch the filesystem for this: a
watcher on a runner is a different feature with a different cost, and an index a person presses is
one they can reason about. The panel says how many files and when, which is what makes a stale
answer diagnosable rather than mysterious.

## ADR-0111: A project decides its own buttons, and how hard its agent thinks

- Status: accepted
- Date: 2026-09-16
- Task: 2.18

### Context
Spec §5.1 asks the session pane for "quick actions from .perch/project.json run commands plus custom
actions, background policy per project: what runs unattended, what waits, auto-settle"; §4 asks the
composer in session mode for a "reasoning level". §11's acceptance is "a custom action runs from the
session pane and from ⌘K". §6's `coding_sessions` has no column for a reasoning level, §7.6 has no
field for one, and `projectConfigSchema` had `run` and a `background` block that nothing read.

Three questions, and the obvious answer is wrong in each.

**Reasoning could have been a string Perch invents and prepends.** "Think harder about this." It
would work on every engine and mean nothing on any of them: a sentence in a prompt is not a setting,
and it would sit in the transcript as if a person wrote it.

**Unattended tools could have been a Perch-side allow-list.** A workspace setting, an admin screen.
But which tools are safe to run without asking is a property of the repository — its test command is
harmless, its deploy script is not — and the repository already has a file that says such things.

**Auto-settle could have been a timer.** End a session that has been idle for N minutes. That is a
different feature (an idle reaper, which the runner already has for its own sessions) and it answers
a different question: "has this been abandoned" rather than "is this finished".

### Decision
**The reasoning level is a session column and an ACP session config option.** `coding_sessions`
gains `reasoning` (`auto`, `low`, `medium`, `high`; `auto` is where a session starts and means "the
agent's own choice"), settable at creation, on `PATCH /api/sessions/{s}`, and per turn. It travels
to the runner as an optional `reasoning` on §7.6 `session.send`.

What the ACP adapter does with it is the part worth writing down. ACP 1.4 gives a session config
option the category `thought_level` — the protocol has a place for exactly this — so the adapter
looks for that option, then for one whose id or name says reason/effort/think, and sets it with
`session/set_config_option`. The value is matched to the agent's own vocabulary by name
(`low` also means `minimal`, `fast`, `off`) and, failing that, by position: first is least, last is
most. Refusing to map a level whose name Perch does not recognise would make the control do nothing
on most agents. An agent that advertises no such option ignores the level entirely, and the docs say
so rather than pretending otherwise.

**The background policy is the project's file, and it is two separate things.**
`background.unattended` is a list of tool names — literal, or one trailing `*` — that may run with
nobody watching: the api answers that permission `allow` itself and writes a `tool_result` into the
transcript saying the project allowed it, rather than leaving a record that looks like somebody
pressed a button. `background.autoSettle` ends a session once a round finishes with nothing waiting
on a person, so a background run does not hold a runner open for a conversation nobody is having.
Neither weakens the policy engine (task 2.11): what the tool then does is still governed by
`.perch/policy.yaml`, and a denied command is still denied.

**Actions are the run commands plus the project's own, merged.** Every key of `run` is already an
action — a project that declares `test` has said what pressing Test should do — and
`config.actions` adds named ones that can take a run key over by using its id. An action is either a
`prompt` (a turn in the session, in the action's own mode and level) or a `run` (typed into the
project's terminal, where its output belongs), never both, because a button a person presses has to
have one obvious outcome. They appear as a row in the session pane and as commands in ⌘K; from ⌘K
with no session open, the action waits in a small store while the route opens one.

**`.perch/project.json` can be re-read without re-cloning.** The file is the project's own document
and changes with a pull or an edit; before this, the only way Perch noticed was `project.setup`,
which deletes and re-creates the checkout. §7.6 gains `project.config`, which re-reads the two
checked-in files where the project already is, behind `POST .../projects/{p}/config/reload`.

### Consequences
Migration `0022_session_reasoning.sql` adds the column and its check constraint.
`REASONING_LEVELS` lives in `@perch/events` beside `sessionModeSchema` and in `@perch/db` beside the
session modes, because both the wire and the column need it.

`project.config` is additive to §7.6 and registered in `packages/events/test/events.test.ts`
alongside the other additions. `session.send` gains an optional field rather than a new method,
which older runners ignore.

The shell gains `setCommands` so a screen can contribute to ⌘K and take its commands away when it
leaves. Today only Code mode uses it; Home and Inbox are the obvious next callers.

`projectActions` is derived, never stored: there is one source of truth for what a project can do,
and it is the file in the repository. A project whose `project.json` is malformed keeps its old
config and says why in `config_error`, exactly as it did at setup.

## ADR-0112: A bot outside Perch is a token, its installs, and a socket that tells it things

- Status: accepted
- Date: 2026-09-16
- Task: 2.19

### Context
Spec §7.3 gives the Bot API a Slack-shaped surface, seven scopes, "Rate limit 60 req/min per bot
with Retry-After on 429", and "Events via wss:///api/bot/socket or HMAC-signed webhook". It does not
say where a bot's token comes from, what a bot may see, or how a socket decides what to send. §6 has
no table for a bot's credentials, and §11's acceptance is "an external script posts a message and
receives an app_mention".

### Decision
**A bot token is a row, minted per bot, and shown once.** `bot_tokens` (migration
`0023_bot_tokens.sql`) stores the sha-256 hash, a hint, its scopes, who made it, when it was last
used, and when it was revoked — the same shape `api_tokens` already has, for the same reason. The
value starts `pbot_`, which is what tells a bot's bearer apart from a person's at the door. Minting
and revoking live on the bot's card in the Forge and under `.../bots/{bot}/tokens`, authorized with
`bots.write`: giving a program the right to act as a bot is an admin decision, not a bot's.

**No Bot API call names a workspace.** A token names one bot, a bot belongs to one workspace, so the
routes are `/api/bot/chat.postMessage` rather than `/api/workspaces/{ws}/…`. A bot that had to say
which workspace it was in could try to say the wrong one.

**A bot's subscription is its installs.** There is no subscribe operation on the socket and no
channel parameter that widens anything: `conversations.list` is the channels the bot was put in, and
every other call is checked against them. A second way to choose what a bot hears would be a second
permission system, disagreeing with the first about a private channel.

**A scope that was not minted is refused, not narrowed.** A call answers 403 naming the scope it
wanted, so a bot fails loudly at the line that needs more rather than quietly doing less.

**The window is per bot, not per token**, as §7.3 says: minting a second token must not buy a second
minute. It is a fixed window rather than a sliding one, so a rate-limited bot can reason about when
it will not be.

**`Retry-After` is a header, set by the error handler.** Any `rate_limited` PerchError whose details
carry `retry_after` now renders with the header, so the MCP gateway's limits and the Bot API's agree
without either knowing about the other.

**The SDK publishes as `perch-bot-sdk`, unscoped**, staged by `scripts/build-bot-sdk.ts` and pushed
by `release.yml` when `NPM_TOKEN` exists — the same shape, and the same skip, as `perch-dev`. A
scope needs an npm org and nothing about writing a bot should wait on one.

### Consequences
Two of §7.3's endpoints are not here. `work.create` needs work items, which arrive in Phase 3 (§10);
the `work:write` scope exists and is refused until then. The HMAC-signed webhook alternative to
socket mode is not built: the socket is the acceptance path, and a webhook adds a delivery-retry
story that belongs with outbound webhooks rather than with the Bot API. Both are spec deviations,
recorded here.

`files.upload` stores through the same `storeUpload` a person's upload does, so a bot's file obeys
ADR-0094 unchanged: until the bot says it in a channel, the file is the uploader's alone.

Socket mode takes its token as a query parameter, because a browser's `WebSocket` cannot set a
header and an external bot may be running in one. The token is checked on open and the socket is
closed with 1008 if it is not one; it is never logged, and the `hello` frame carries the bot's
identity so a script does not have to ask.

`channel.joined` is emitted off the existing `bot.installed` bus event: being put in a channel is
the one thing a bot cannot learn by listening, because until it is installed it hears nothing from
there at all.

## ADR-0113: A register of long lists, because virtualization is a decision and not a number

- Status: accepted
- Date: 2026-09-16
- Task: 2.20

### Context
Spec §8 asks CI for a "perf audit" and §11's task 2.20 names three gates: the WS payload budget, the
bundle size budget, and a "list virtualization check". The first two were built in task 0.15 and are
numbers with budgets. The third is not: ground rule 7 says "every long list is virtualized", which
is a property of each screen, and nothing in a bundle or an envelope can measure it.

### Decision
**`LIST_SURFACES` in `scripts/perf-budget.ts` is the register.** Every list Perch renders from
server data has a line saying how it is kept short, and the audit checks the claim:

- `virtualized` — the file must render through `VirtualList` or its own `useVirtualizer`.
- `capped: n, in, proof` — the named file must still contain that string. Delete `SIDEBAR_ROWS = 30`
  or `limit: 100` and the audit says which cap went and where it was.
- `bounded: why` — a reasoned exemption, written down where a reviewer sees it. Three qualify: the
  editor's open tabs, the drawer's four tabs, a preview's ports and share links. Each grows with
  what one person did, not with the size of the workspace.

**And a net, which is the part that matters.** Any `.tsx` under `apps/web/src` or `packages/ui/src`
with its own scroll container and a `.map(` that is not in the register fails the audit. A new
screen cannot ship a long list without somebody writing down how it stays fast.

**One `VirtualList`, not five.** Perch had four virtualized lists and each had built its own
scroller. `packages/ui/src/components/virtual-list.tsx` is that scroller once: a labelled `<ul>`
whose rows carry `aria-setsize` and `aria-posinset`, so a screen reader is told how long the list
really is rather than how much of it is in the DOM.

**`VirtualList` is behind `@perch/ui/virtual-list`, not the barrel.** On the barrel it put
`@tanstack/react-virtual` in the entry chunk and the initial-paint budget went from 179.8 KB to
187.6 KB — over 180. It is off it for the reason ADR-0085 keeps i18n fragments off it, with a
library instead of strings: the virtualizer belongs to the screens that have long lists, not to the
first paint.

**Two lists that were not virtualized now are**: Home's every-channel list and the Git panel's
changed files. A workspace's channels have no ceiling and a refactor can touch thousands of files.

**The sidebar is capped rather than virtualized.** `Sidebar` is one scroll container for every
section, so a section cannot own a virtual window without nesting scrollers inside it, which is
worse to use than the problem. Channels, DMs and Bots show the first `SIDEBAR_ROWS` (30) by weight
and a last row saying how many more there are; on Channels that row links to Home, where the whole
list is virtualized.

### Consequences
`bun run perf` gains a `long lists` line and the CI step is renamed to say so. `scripts/perf-budget.test.ts`
covers the gate itself: this repository passes, a surface that stops virtualizing is named, a cap
that disappears is named, and an unregistered scrolling list is named.

The register is a maintenance cost by design. Renaming a file or moving a cap breaks the audit,
which is the point: the alternative is a rule in a document that nothing enforces.

`PALETTE_SHOWN = 50` caps ⌘K's commands per group, which is new. Nothing reaches it today; the
palette takes commands from whatever screen is open (ADR-0111), so it is the one list whose length
is decided by code rather than by data.

## ADR-0114: Phase 2's exit criterion is one afternoon, not seven specs

- Status: accepted
- Date: 2026-09-16
- Task: 2.21

### Context
Spec §2's Phase 2 exit is seven clauses: a team of three uses it daily; @grok answers in #general; a
Vercel deploy posts its preview URL in a thread; clicking a button in Preview and typing "make this
primary" lands the right edit; a permission is approved from the phone inbox; a channel pinned to
local models refuses a cloud model; three bots complete a fan-out and a ping-pong pair trips the
breaker. Six of the seven already have a spec of their own. Task 2.21 asks for the criterion "as
Playwright specs" and an "axe sweep on Home, Code, Inbox".

### Decision
**`e2e/phase2.e2e.ts` is one test, not seven.** Task 1.22 did the same for Phase 1, for the same
reason: the clauses passing separately is what the feature specs already prove. What the exit
criterion asks is whether they hold *together*, in one workspace, with the state each one leaves
behind — and the first clause, "a team of three uses it daily", is not a feature at all. It is the
sentence the other six are in.

**Three browsers and a phone.** Ada sets the nest up and ships it, Grace joins by invitation and
asks a bot in the channel the policy pins, Linus points at the page in Preview, and Grace's
permission is approved from a phone context opened from her own storage state — the same account on
a 390 px viewport, which is what "the phone inbox" means. One Playwright project, `phase2`, at a
laptop's viewport, because the spec opens the phone itself; the phone is where the criterion says it
has to work, not where the whole afternoon happens.

**The axe sweep runs where the person is.** Home after the nest is set up, Code with the project
open, Inbox on the phone. Each sweep names the screen in its failure message, because a violation
that says only `color-contrast` in a 400-line spec is a worse bug report than one that says where.

**The bots' words are scripted in the stand-in provider, by handle.** `SCRIPTED` in
`scripts/e2e-server.ts` gives `desk` two specialists to tag, `crypto` and `gaming` their pieces, and
`ping`/`pong` each other. Anything not in that map still answers with what it was asked, which is
what the other specs rely on. The fan-out and the breaker were covered by `apps/api/test/chains.test.ts`
from the model's side; this is the first time they run in a browser.

### Consequences
`bun run e2e` gains one project and about twenty seconds. The `desktop` and `mobile` projects ignore
`phase2.e2e.ts` the way they already ignore `phase1.e2e.ts`, so the afternoon runs once rather than
at two viewports.

A spec this long fails in more places than a short one, and each failure is now a claim about the
whole phase rather than one feature. That is the point, and it is also the cost: when it goes red,
the feature spec beside it says which clause.

## ADR-0115: A list that only the socket updates is a list that can be wrong

- Status: accepted
- Date: 2026-09-16
- Task: 2.20 follow-up (a red `main`)

### Context
CI went red on `94da876` with one failure, twice over: `deploy.e2e.ts` at a phone's viewport waited
sixty seconds for a project to say "Ready" and it said "Setting up" the whole time. The runner RPC
has a timeout and a setup that fails writes `status: "error"`, so a project stuck on `setting_up`
for two minutes is not a setup that hung — it is a browser that never asked again.

Code's project list refetches when a `project.*` event arrives on the workspace topic and at no
other time. That is right until an event is missed: a reconnect, or a subscribe that lands after
the publish. Then the row says "Setting up" about a project that is ready, until somebody reloads.

### Decision
**The socket is the fast path, not the only path.** `projectsQuery` polls every two seconds while
any project is `pending` or `setting_up`, and stops the moment none is — the same shape the
previews query has used since task 1.18, and for the same reason: something comes up on its own and
a person is watching for it. The predicate lives in `apps/web/src/code/project-status.ts` with no
imports, so it can be tested without a DOM.

**And `deploy.e2e.ts` waits as long as its siblings.** Its project-status assertion was sixty
seconds where `inspector.e2e.ts` already allowed ninety for the same work; it is now a hundred and
twenty. The assertion is unchanged — what a loaded CI machine gets is patience, not a lower bar.

### Consequences
Every list in Perch that a WebSocket keeps fresh has this shape of bug available to it. This one was
found because a project's setup is the slowest thing a person watches; channels, sessions and the
inbox are refetched on the same socket and would show the same staleness for a shorter time. The
honest next step is not to poll them all, but to make a reconnect refetch what it subscribed to —
which is a change to `apps/web/src/lib/ws.ts` and a task of its own, not a fix on a red `main`.

## ADR-0116: A bot in a repository is the repository's, and `model:` names a profile

- Status: accepted
- Date: 2026-09-16
- Task: 3.1

### Context
Spec §5.3 lists spec bots as one of the four ways to make a bot: "spec bots
`bots/<handle>/bot.yaml` + `SYSTEM.md` + `skills/` in the Agent Skills format, hot-reload on push",
with an example whose keys are `daily_usd`, `long_term`, and `model: xai/grok-4.3`. §6's `bots` row
stores a camel-cased `BotSpec` and has no column saying where a bot came from.

### Decision
**The repository is the source of truth, and a sync makes the workspace match it.** A new directory
becomes a bot, a changed one is rewritten, a directory that is gone takes its bot with it. Rows
carry `source_project_id` and `source_path` (migration 0024), and the sync only ever looks at rows
that name the project it is syncing — a bot made in the Forge is never touched by a `git pull`.

**`model:` in `bot.yaml` names a model profile, not a vendor's model id.** The spec's example says
`model: xai/grok-4.3`, which reads as a provider and a model. Perch has no way to run that: a
self-hosted instance reaches every model through a profile, which is where the credential, the
policy's per-channel allow-list and the budget live (ADR-0064). A raw vendor id in a file anybody can
commit would be a credential nobody granted. So the value is read as the profile's name, and the
file can still say `profile:` if it prefers. Recorded as a spec deviation.

**The file is written the spec's way; the column keeps §6's.** `daily_usd`, `long_term` and
`max_steps` are what a person writes; `dailyUsd`, `longTerm` and `maxSteps` are what is stored.
Triggers take any of three forms — a bare word (`dm`), a shorthand block (`{schedule: …}`,
`{keyword: …}`), or the long form the column stores — because the spec's own example uses two of
them in one list.

**One bad directory does not lose the rest.** A `bot.yaml` that stops parsing pauses that bot and
keeps the reason on its row; every other bot in the repository still syncs. A handle another bot
already holds is refused with a reason rather than taken, because a handle is a name people type and
two bots cannot share one.

**A push hot-reloads, and it cannot fail the push.** `git.push` syncs after the push succeeds and
swallows what the sync throws into the log, because a repository whose bots stopped parsing is still
a repository somebody is entitled to push. The Git panel's Reload bots button is the same sync,
asked for by hand, and it is where the errors are shown.

### Consequences
Syncing reads files on the runner, so it needs the project to be ready and its runner online — the
route answers 409 otherwise, like every other file call.

A synced bot's `schedule` triggers become cron jobs through the same `BotsService.reschedule` a Forge
bot uses, so a bot that arrives by `git pull` can wake up on a timer. Removing its directory
unschedules it before the row goes.

The idempotence check compares the spec and budget order-insensitively, because jsonb hands back its
own key order: a repository nobody touched must not look like one that changed.

## ADR-0117: A code bot has no permission a form bot does not

- Status: accepted
- Date: 2026-09-16
- Task: 3.2

### Context
Spec §5.3: "code bots `export default bot({ onMessage, onSchedule, onWebhook })` with
`@perch/bot-sdk` in a QuickJS sandbox". §9.3 fixed the ceiling at a 200 ms CPU budget, and spike
0.4.5 (ADR-0033) proved the shape: the sync release build, an interrupt handler, a memory limit, and
host tools as QuickJS promises settled from the host.

### Decision
**`perch` inside the sandbox is the bot's own tool allow-list, nothing more.** A code bot calls
`perch.chat_post(…)`, `perch.http_fetch(…)` and the rest through the same registry a native bot's
model calls, narrowed the same way by its spec and its install. A tool the bot was not granted is
not a property on `perch`, so the refusal is a `TypeError` in the bot's own code rather than a
permission check somewhere else. There is no second surface to keep in step.

**`@perch/bot-sdk` is not what runs inside.** The published SDK is HTTP and a WebSocket, which a
sandbox with no host cannot do; what a code bot is written against is the same *shape* — named
methods, awaited — backed by the host. The spec's sentence is read as "the bot-sdk's shape", and
that is a deviation worth naming.

**Two ceilings, because one is not enough.** The interrupt handler only fires while JavaScript is
running, so a bot waiting on a tool is invisible to it: `cpuMs` (200) bounds one slice and is reset
each time a tool answers — so a bot that awaits twice is not punished for the wait — while `wallMs`
(15 s) bounds the whole run from outside. `toolCalls` (32) bounds a loop made of allowed calls,
which neither of the others would catch.

**`export default` is rewritten, `import` is refused.** QuickJS has no module system. The one-line
rewrite turns the spec's `export default bot({…})` into an assignment; an `import` throws before
anything runs, because silently ignoring it would fail later in a way nobody can read.

**A failed run is a row, not an exception.** A bot that loops, throws, or runs out of memory comes
back with `error` set, the reason is posted where it was asked, and `bot_runs` records it. Nothing a
bot's file does can fail the request that triggered it.

### Consequences
`bots.code` (migration 0025) holds the JavaScript, synced from `bots/<handle>/bot.js` by task 3.1's
sync, so a code bot arrives, changes and leaves with its directory like a spec bot does.

A code bot spends nothing: `bot_runs` records zero cost, because no model was asked. Budgets still
apply to the runs-per-hour ceiling, which is the one that matters for something this cheap to start.

The QuickJS runtime is created per run and disposed after it. That is a few milliseconds of setup
per event, which is far below what a model call costs and buys a bot that cannot keep anything
between runs except what it `remember`s through a tool.

## ADR-0118: A grant is checked where the tool is called, and the audit says who called it

- Status: accepted
- Date: 2026-09-16
- Task: 3.3

### Context
Spec §3.5: "workspace connections are admin-created with explicit grants (bots, channels, tools)".
Task 2.14 built `connection_grants`, the grants UI, and `ConnectionsService.mayUse` — and nothing
called it. The Bot API's `tools.call` (task 2.19) refused a personal connection and then handed the
gateway `allowList: null`, so any bot token with `tools:call` could call any tool on any workspace
connection. The gateway's audit line, meanwhile, wrote `callerType: "user"` whoever was calling.

### Decision
**`mayUse` is called where the tool is.** A bot's `tools.call` fails with 403 and a reason when the
connection was not granted to it, and the grant's `allowed_tools` becomes the gateway's allow-list,
so a tool outside the grant is refused by name before the upstream is contacted. Refusals are
audited, because a denied call is a thing that happened.

**`callerType` is who actually called.** It comes from the actor on the event rather than a literal.
A bot's tool call audited as a person's is a lie in the one record meant to settle arguments.

**`mayUse` takes an invoker that may be nobody.** An external bot with a token of its own is a
program, not somebody's turn, so it passes `invokedBy: null` and an `obo` grant refuses it. In
practice a workspace connection already refuses `obo` when the grant is made, and a personal
connection is refused before this; the null case is the belt to that pair of braces, and it is what
makes the rule true at the call rather than only at the form.

### Consequences
A bot that could call a workspace connection's tools before this can no longer do so until somebody
grants it — which is the rule §3.5 states and a change in behaviour worth saying out loud. The grants
UI from task 2.14 is where that is done.

`interaction.received` needed nothing: task 2.5 emits it on the bot-events seam addressed to the
message's bot author, and task 2.19's socket forwards it. What was missing was a test that a button
press crosses all of it — the person's press, the socket, and `chat.update` rewriting the message in
place rather than saying it twice.

## ADR-0119: A provider's signature scheme is a line in its manifest

- Status: accepted
- Date: 2026-09-16
- Task: 3.4

### Context
Spec §3.5: "inbound webhooks at /hooks/:provider/:id with signature verification → channel cards",
and a manifest field `webhook_signature` that says only `hmac_sha256` or `none`. That is not enough
to check one: GitHub sends `X-Hub-Signature-256: sha256=<hex>` over the body, Vercel sends a bare hex
digest in its own header, and Clerk uses Svix — `v1,<base64>` over `<id>.<timestamp>.<body>`, valid
for five minutes. Three providers, three schemes, one field.

### Decision
**The manifest says where the signature is and what was signed.** A `webhook:` block gives the
header, the prefix, the encoding, a `signed` template (`{body}`, `{id}`, `{timestamp}`), the headers
carrying the delivery's id and event name, and a tolerance. The three schemes above are three blocks
of YAML, and a fourth provider is a fourth file — which is the rule the connectors have followed
since task 1.16.

**Verification is pure.** `verifyDelivery` takes headers, a body and a secret and returns a verdict;
it reads nothing and writes nothing. That is what lets it be tested against real signatures, and it
is why the route hands it the body exactly as it arrived rather than anything re-serialized.

**The same delivery twice is one card.** `webhook_deliveries` has a unique index on
`(webhook_id, delivery_id)` and the insert decides: a second delivery is a `200` saying `duplicate`,
not a second card. A provider that sends no id is deduplicated on a hash of its body instead — which
is weaker, and is the best that can be done for a provider that will not identify itself.

**Every refusal answers the same way.** A wrong id, a wrong provider on a right id, and a paused
endpoint are all `404`; a bad signature is `403`. Nothing says which part was wrong in a way that
helps somebody guessing.

**A delivery is a card, not a message from anybody.** The card is posted as `system`, because a
webhook is not a person and not a bot. Perch reads a handful of fields it knows — a push's ref,
commits, pusher and compare link — and titles the card from them; anything else is titled with the
provider's own event name, which is still worth a card.

### Consequences
`/hooks/:provider/:id` is the only unauthenticated write in Perch. It reads the raw body, caps it at
a megabyte, and does nothing at all before the signature checks out.

`webhook` joins the trigger kinds a bot can fire on, with `match:` narrowing to a provider or to
`provider:event`. The bot answers in the card's thread, so its reply sits under what happened.

`webhook_card` is a new message block. It renders in the transcript beside `deploy_card`, and every
string in it is the provider's — clipped, never executed, and wrapped as untrusted before any model
sees it, like every other tool output.

## ADR-0120: A cron expression means an hour somewhere

- Status: accepted
- Date: 2026-09-16
- Task: 3.5

### Context
Task 2.6 put a bot's `schedule` triggers on the Postgres queue, which read every expression in UTC.
Spec §5.3's own example is `schedule "0 9 * * 1-5"` with the prompt "Post today's gaming + crypto
headlines" — a morning digest, which is nine o'clock *somewhere*, and in UTC it drifts an hour twice
a year for most of the world. §11's task 3.5 asks for a per-bot timezone, a catch-up policy, and a
run ledger.

### Decision
**The zone lives on the bot and travels with the job.** `spec.timezone` is an IANA name; `jobs`
gains a `timezone` column (migration 0027) so a scheduled row carries the zone it was written in and
`complete()` computes the next run in it. Every schedule made before this one meant UTC, and a null
column still means UTC, so nothing moves under anybody.

**A typo is refused where it was written.** `botSpecSchema` checks the name with `Intl`, so a bot
with `Mars/Olympus_Mons` is a 422 when it is saved rather than a 500 the first time it is scheduled.
`nextCronRun` falls back to UTC rather than throwing, because a job already in the table must still
fire.

**Catching up is the default, and the bot may say otherwise.** Perch is not always up at nine. A
missed firing runs late for up to `catchUpGraceMinutes` (an hour); `catchUp: false` skips it instead,
which is what a greeting wants — arriving at noon saying good morning is worse than not arriving.
The policy is read in the bots service from the job's own `runAt`, not in the queue, because it is a
question about what the bot is for and the queue has no opinion about that.

**The ledger is `bot_runs`, read back per cron.** A scheduled run already records its trigger and
its `triggerRef` (the expression), so "when did it last fire" is a query rather than a new table.
`GET .../bots/{bot}/schedules` joins that to the queue's own rows for `next_run_at`.

### Consequences
A minute either side of the due time is not "late": clocks and pollers are not that precise, and a
worker that claims a job forty seconds after it was due should run it whatever the policy says.

The schedules endpoint indexes by position among the *scheduled* triggers, which is the same index
`reschedule` uses for its `bot:<id>:<n>` keys. Reordering a bot's triggers reshuffles those keys,
which is already true and is why `reschedule` unschedules every key beyond the current count.

## ADR-0121: A bot's MCP tools are its grant, not its spec

- Status: accepted
- Date: 2026-09-16
- Task: 3.6

### Context
Spec §5.3 ends the native tool list with "MCP attach (any MCP server)", and §3.5 says a tool marked
`requires_permission` "returns pending + inbox item, completes on approval". A bot's spec is a
document its author writes; a connection is a credential an admin added. If the spec decided what a
bot could reach, writing `mcp: [{connection: github}]` into a YAML file would be enough to spend
somebody else's token.

### Decision
**The spec asks, the grant answers.** `spec.mcp` is a list of connections a bot would like, and it
is only ever narrowing: `narrowTools(grant, asked)` intersects the two, so a spec can ask for fewer
tools than it was granted and never for more. A connection with no grant for that bot contributes
nothing and says so in the log rather than failing the turn — a hopeful spec should be quiet, not
broken.

**The tools are built where the model runtime lives.** `packages/bots/src/mcp.ts` turns a list of
`AttachedServer` — a provider name, its tools, and two closures — into a `ToolSet`. The api closes
those over the gateway; nothing in `packages/bots` can see a connection, a vault or a token, which
is what keeps AGENTS.md §1.6 true by construction rather than by review. `apps/api` gained no
dependency on `ai` for this: the `ToolSet` type is re-exported from `@perch/bots`.

**A tool from an upstream is namespaced and wrapped.** `mcp__<provider>__<tool>`, so an upstream
cannot publish a tool called `remember` and shadow a native one, and every answer comes back through
`untrusted()` — an MCP server is somebody else's words, the same as a fetched page.

**A permission is a row, not a held-open turn.** The bot's turn does not wait for a person: the call
is written to `bot_tool_calls` as `pending`, the model is told it asked and should stop, and the
question is put twice over — an `approve_deny` card in the thread, and an inbox item. Approving
moves the row out of `pending` in one statement (so two people pressing Approve run the call once),
re-checks the grant (it may have been revoked while it waited), runs it through the gateway, and
posts the result in the thread. The alternative — blocking the turn on a human — holds a model
connection open for as long as somebody takes to look at their phone.

**Two events the spec's §7.7 list does not name.** `bot.permission_requested` and
`bot.permission_answered` exist because the inbox subscribes to the bus and never to a feature
(§9.1). Without them the bots service would have to write inbox rows itself, which is the coupling
that rule exists to prevent. This is the deviation from §7.7 this task carries.

**Runner-local stdio is a different job.** §11's line for this task names three sources: a
connection's server, a pasted URL, and a runner-local stdio one. The first two are the same code
path — a connection whose `mcp_url` points wherever an admin pasted — and ship here. The third is a
runner protocol method (`mcp.spawn`, §7.6, shaped but not implemented) plus a JSON-RPC transport
over a runner stream socket, with no credential and no grant in it at all. It is task 3.24.

### Consequences
A bot's permission card is posted by the bot, so it arrives in the thread under what was asked and
answers through the interaction seam every other block uses (task 2.5). It carries the bot's *name*
rather than its handle, because a card that says `@scout` would mention the bot that posted it.

`requires_permission` is per grant, not per manifest: the same tool can need a person for a bot in
a shared channel and not for a session its owner is watching. A manifest-level default would be a
better answer for the common case, and can be added later without moving this.

## ADR-0122: An agent bot's session belongs to the thread it came from

- Status: accepted
- Date: 2026-09-16
- Task: 3.7

### Context
Spec §5.3 says an agent bot is `engine: opencode|acp` plus `projects: [...]`, and that `@dawn add a
dark-mode toggle` "opens a session on that project, posts a session_card in the thread, asks
permissions in-thread, and finishes with a diff_card, Open in IDE, and a PR link". §10's Phase 3
exit criterion is the same sentence, shorter: from chat, a diff card and a PR.

Two things had to be decided: where the coupling between a chat and a session lives, and how far a
finished session gets on its own.

### Decision
**The session carries the chat, and the chat subscribes.** `coding_sessions` gains `channel_id` and
`bot_id` (migration 0029). Nothing pushes updates into the thread; a subscriber watches
`session.permission_requested`, `session.done` and `session.error` and posts into the thread of any
session that has those two columns set (§9.1). The session service gained three optional fields and
no knowledge of chat at all.

**`AgentBotsService` is its own service, on both seams.** The bots service holds an `AgentSessions`
interface with one method and is handed an implementation at boot. It does not import the session
service, and the session service does not import it — which is also why `bots` and `sessions` could
be built in either order once the seam existed.

**A bot's turn is over once the session is open.** `runAgent` finishes the `bot_runs` row as soon
as the card is posted rather than waiting for the engine. A bot run is a model turn's ledger, and an
agent bot's turn costs nothing: the session keeps its own. Holding the run open for an hour would
also hold a chain hop open, and the chain breaker would eventually trip on work that was going fine.

**An engine's permission is the same `approve_deny` block as everything else.** The block id encodes
`session.permission:<sessionId>:<permissionId>`, the answer arrives on the interaction seam (task
2.5), and it is passed straight to `respondPermission`. No new transport, and the session pane's own
prompt still works — whoever gets there first answers it.

**Finishing ships.** `services/ship.ts` does branch → secret scan → commit → push → pull request in
one call and stops at the first step it cannot take, saying which. It is a service rather than four
route handlers because an agent has nobody to press the four buttons; the Git panel's endpoints stay
as they are, and `wholeChange` — the secret scanner's reader — moved out of `routes/git.ts` into it,
so the gate is one implementation rather than two. `pullRequest: false` on a bot opts out.

**The push connection is named, then guessed, then not.** `spec.connection` wins. Otherwise a
connection whose provider matches the repository's host, workspace-owned before personal. Otherwise
the workspace's only connection, which can only be wrong if there was never a right answer. A guess
past that point would be spending somebody's credential on a hunch.

**A card carries its own link.** `session_card` and `diff_card` gained `url` (a path in this Perch)
and the diff card `prUrl`/`prNumber`. The alternative — the client joining session → project → key →
workspace slug to build the link — puts routing knowledge in a renderer for something the api knew
when it posted it. The inbox already works this way.

### Consequences
The commit is authored as the bot (`<handle>@bots.perch.local`) rather than as its owner, because
the owner did not write it. The session, the push and the audit trail are all still the owner's:
they are who has a runner and a credential.

An engine that asks for a permission and gets no answer waits as long as the session's silence timer
allows, exactly as it does in the pane. Nothing in this task shortens that; a permission that nobody
answers is the inbox's problem, and the inbox already has session permissions in it.

## ADR-0123: Hermes is the ACP client with a Hermes-shaped launch

- Status: accepted
- Date: 2026-09-16
- Task: 3.8

### Context
Spec §3.3 lists `hermes` among the Engine interface's ids — "hermes = Hermes Agent runtime for Nest
agents (Phase 3)" — and §9's rule 13 says bespoke adapters exist only "for extras an agent offers
beyond ACP (OpenCode) or for runtimes that don't speak it yet (Hermes)". That parenthesis was true
when the spec was written. It is not any more: Hermes Agent ships `hermes acp`, an ACP server over
stdio with stdout reserved for JSON-RPC and logs on stderr (verified against its own docs,
2026-09-16).

### Decision
**No second protocol.** The `hermes` engine is the ACP client the runner has had since task 1.9,
launched as `hermes acp` (falling back to the `hermes-acp` console script the `[acp]` extra
installs, and to `PERCH_HERMES_COMMAND` for a checkout off the PATH). Writing a bespoke adapter for
a runtime that speaks the contract would be a second mapping of the same events to maintain, and
§3.3's own rule says not to.

**An engine id of its own, not a registry entry.** `hermes` could have been one more row in
`ACP_AGENTS` next to gemini and codex. It is not, because the engine id is what a project's
`.perch/project.json` and a bot's spec name, and `hermes` is one of the ids the spec gives the
Engine interface. A session that says `engine: "hermes"` should not also have to know that the agent
behind it is called hermes.

**The model travels as `HERMES_INFERENCE_MODEL`.** `hermes acp` publishes no flags of its own; the
CLI documents that variable as the equivalent of `--model`. A session on the engine's own default —
`provider: "engine"` — sets nothing, so Hermes uses what the person configured. Perch chooses a
model; it does not hand over a key.

**Lane B by doing nothing.** Hermes reads `~/.hermes`, and the runner already runs an agent with the
person's own `HOME` (`/data/homes/<user>`, task 1.2). So a Nous Portal or Codex subscription signed
in through the terminal is that person's, serves only their sessions, and never enters the vault —
spec §3.6's Lane B, arranged by not arranging anything. The acceptance test checks exactly this: the
environment Hermes was handed carries the model and that home, and no Perch credential.

**Installed from its repository, at a tag.** Upstream deprecated the `hermes-agent` PyPI package at
v0.19.0; the supported install is a checkout. The runner image clones `v2026.9.14` into a venv of
its own and installs `-e '.[acp]'` (Python 3.12, within its `>=3.11,<3.14`), which is what puts
`hermes` on PATH. Pinned like every other dependency and recorded in docs/dependencies.md.

### Consequences
This is the first engine whose runtime is Python. It lives in `/opt/hermes` with its own venv rather
than in the image's system Python, so nothing else in the runner is affected by what it pulls in.

A Hermes session's `agent` column stays null: there is one program behind this engine and naming it
twice would be noise. The refusal when Hermes is missing names the binary rather than the engine,
because "hermes is not installed" is actionable and "the hermes engine is unavailable" is not.

Spec deviation: §9's rule 13 describes Hermes as a runtime that does not speak ACP. It does now, and
this ADR is the record that the rule was followed rather than the parenthesis.

## ADR-0124: The Nest is a roster, not a runtime

- Status: accepted
- Date: 2026-09-16
- Task: 3.9

### Context
Spec §5.3 ends its bots section with "Nest agents (Birbus orchestrator; Dawn, Julius, Paige, Kimi
specialists) join via the Bot API or the hermes adapter", and §10's Phase 3 exit asks that "a Nest
agent posts via the Bot API using a granted Supabase connection". Neither says what a Nest agent *is*
in the database.

### Decision
**They are bots, made from data.** `packages/bots/src/nest.ts` is a list — handle, name, persona,
triggers, budget, which door, what it expects to be granted — with no imports, like the Forge's
templates, so a browser can show the roster without the runtime. `NestService.install` turns entries
into ordinary rows in `bots`. Nothing about them is privileged afterwards: edit, re-scope or delete
them like anything else, and a second install takes nobody's name — a handle already here is
reported and left alone.

**The door decides the level.** `door: "bot_api"` makes an `external` bot with a token minted once
(§7.3): the agent runs wherever it already runs and Perch is somewhere it talks. `door: "hermes"`
makes an agent bot with `engine: "hermes"` and the workspace's projects (tasks 3.7, 3.8): Perch runs
it. Dawn is the hermes one, because the whole point of Dawn is that a mention becomes a session.

**Installing grants nothing.** Kimi's entry says it expects a `supabase` connection; that is a label
on a card and a line in the response, not a grant. A grant is an admin's decision on the Connections
page (spec §3.5), and until one exists the agent is refused with a 403. The acceptance test checks
that order explicitly: the call before the grant is refused and never reaches the provider.

**Kimi is the data specialist.** The spec names the five and says what Birbus, Dawn, Julius and
Paige do; it does not say what Kimi does. Read against §10's exit criterion — a Nest agent on a
granted Supabase connection — the gap in the team is the one who answers from the data, so that is
what Kimi is. Read-only is written into its persona and its skill, not just hoped for.

**Its own path, not under `/bots`.** `/api/workspaces/{ws}/nest`, because `/bots/nest` collides with
`/bots/{bot}` and resolving that by route ordering is a trap for whoever adds the next route.

### Consequences
The roster is Perch's opinion about a good team, and somebody else's Nest will differ. It is data in
one file for exactly that reason: a fork edits the list, and nothing else changes.

Birbus carries `orchestrator: true` and the tools to tag and wait, but what an orchestrator *does*
with a fan-out — the plan card, the per-child budgets, folding the answers back — is task 3.10. Until
then Birbus is a bot that may tag other bots, which is what task 2.7 already gives it.

## ADR-0125: The passkey plugin is not part of the first paint

- Status: accepted
- Date: 2026-09-16

### Context
The initial-paint budget (`scripts/perf-budget.ts`, 180 KB gzipped for everything `index.html`
references) had drifted to 179.9 KB — a tenth of a kilobyte of headroom, which means the next task
to touch the entry fails the gate for a reason that has nothing to do with it. A budget that can
only be met by adding nothing is not a budget; it is a wall.

### Decision
**Two auth clients, one session.** `lib/auth-client.ts` makes a better-auth client with no plugins
and is what the shell imports — it asks who you are before anything is drawn, so whatever is in it
is downloaded by everyone. `lib/passkeys.ts` makes a second client with `passkeyClient()` and is
imported by exactly the two screens that use passkeys: signing in, and settings → security. Both
speak to the same endpoints and the same cookie, so there is one session; what they do not share is
code nobody else needs.

Measured: 179.9 KB → 176 KB, so the passkey plugin was 3.9 KB of every first paint for a feature
used on two screens.

### Consequences
Four kilobytes is not much, and the point is not the four kilobytes: it is that the budget has room
again, and that the way to find more is the same — look at what the shell imports, and ask which of
it belongs to a screen instead. `virtual-list` moved out of the `@perch/ui` barrel for exactly this
reason in task 2.20 (ADR-0113).

The passkey e2e (Chromium's virtual authenticator, desktop and mobile) covers both screens and
passed unchanged, which is what makes this safe: a split that silently broke sign-in would have
shown up there.

## ADR-0126: An orchestrator fans out in one call, with a share each

- Status: accepted
- Date: 2026-09-16
- Task: 3.10

### Context
Task 2.7 gave bots `mention`, `wait_for_replies` and `hand_off`, plus the rails: hop limits, the
repeat-pair breaker, a per-thread budget. §11's line for 3.10 asks for three more things —
"a plan card, per-child budgets, and a result the orchestrator folds back" — and for the
`orchestrator: true` flag to mean something, which until now it barely did.

### Decision
**`fan_out` is one tool call, not three.** A model that tags three bots with `mention` and then
calls `wait_for_replies` has four chances to get the sequence wrong, and there is no moment where
Perch knows the whole plan — which is exactly what a plan card and a budget split need. `fan_out`
takes the tasks together, so the host can post the plan, split the money, tag, wait, and update the
card. A fourth native tool beyond §5.3's list; this ADR is the record.

**The flag is the gate.** `fan_out` refuses a bot without `orchestrator: true`, saying so rather
than failing quietly. Having the tool in a spec is not permission to use it — the flag is, which is
what §5.3 has it for.

**A share is a ceiling, not an allowance.** `ChainState.shares` maps bot id → dollars, written to
the thread's facts by the fan-out and read back by `mayHop`. A pool alone is first-come-first-served:
the first specialist to run can spend everything and the other two get a refusal that is not about
them. A share says how much of the pool is whose. It never *widens* anything — when the thread's
budget is gone everybody stops, share or no share, and a bot with no share is governed by the pool
alone.

**Even shares, not weighted ones.** What is left, divided by the number actually tagged. An
orchestrator could be allowed to say "give Kimi half", but that is a model deciding how to spend
somebody's money on a hunch, and the even split is the one nobody has to audit.

**The plan card is a block, rewritten in place.** `plan_card` joins §5.2's set: rows of
`{handle, text, status, note?, budgetUsd?}`, edited as answers land through the same
`updateMessageBlocks` path a streaming reply uses — no edit history, no "(edited)" mark, because
nobody rewrote anything.

### Consequences
The orchestrator's folded answer lands *above* the plan card and the tags, because a bot's reply
goes into the placeholder its run opened with (spec §5.4). Reading top to bottom you get the answer,
then the working-out. The alternative — holding the placeholder until the end — would leave a bot
that fans out looking silent for a minute.

`wait_for_replies` and `mention` still work exactly as they did, and a non-orchestrator can still
consult one bot at a time. What it cannot do is run three at once on somebody else's budget.

## ADR-0127: A manifest says how a provider is spoken to; the harness proves it

- Status: accepted
- Date: 2026-09-16
- Task: 3.11

### Context
Task 1.16's manifest schema was written against four providers that all look alike: a bearer token,
a JSON API, a hex HMAC over the raw body with the delivery's id and type in headers of their own.
§5.5's seed list is not like that. Slack signs `v0:<timestamp>:<body>` and puts the event id in the
body. Stripe sends `t=<ts>,v1=<hex>` in one header, so the timestamp is an entry inside the
signature rather than a header beside it. Linear wants the token with no `Bearer` in front of it and
has no GET that proves a key works, because its API is GraphQL over POST. Notion refuses every
request that does not carry `Notion-Version`.

Each of those is one line of YAML or a special case in TypeScript. The whole point of a manifest is
that it is the first one, so the schema had to grow. And once a connector is a file that a person
can write — which §5.5 says it is, and which this task makes true for files outside the repo — the
file needs something that tells them it is wrong before a connection does.

### Decision
**Four additions to the manifest schema**, all optional and all defaulted to what the four original
connectors already did:

| Field | Means |
|---|---|
| `token_scheme: bearer \| raw` | whether the token goes behind `Bearer `. Default `bearer` |
| `headers: {…}` | headers on every call Perch makes for this provider, REST and MCP alike |
| `webhook.timestamp_prefix` | the entry prefix the timestamp is behind when the signature header is a list |
| `webhook.id_header` / `event_header` now optional | a provider that puts neither in a header is normal, not a misconfiguration |

Dropping the `x-github-delivery` / `x-github-event` defaults is the one change that is not purely
additive: a manifest that relied on them now has no id header. Every connector that signs sets both
explicitly, and the alternative — a Stripe delivery looked up under GitHub's header name — is worse
than a missing field. Deliveries without an id are already deduplicated by a hash of the body, so
nothing regresses.

**A refresh happens on use, not on a timer.** `tokenFor` is the only place a connection's token
leaves the vault, so it is the place that knows a call is about to happen. A token expiring within
a minute is swapped first, on the same client the connection was made with, and the call goes out
with the new one. §3.5's words are "refresh jobs on the Postgres queue"; this is the same promise
without the queue, and it is a deliberate deviation. A job would refresh tokens nobody is using, run
on a clock that a laptop closing the lid stops, and still have to check expiry at the point of use
for the connection that expired between ticks. A refresh the provider refuses marks the connection
invalid, which is what the timer would have done.

**A connector can be a file the repo has never seen.** `PERCH_CONNECTORS_DIR` is read at boot, on
top of the built-ins, keyed by directory name — so a file can add a provider or replace one that
ships badly, without a fork and without waiting for a release. An unreadable file is logged and
skipped; it never keeps an instance from starting.

**The harness is a function, and `perch connectors check` is its terminal.** `checkManifest` parses
the file and then exercises what it claims: it signs a delivery with the manifest's own scheme,
verifies it, changes a byte, and signs with somebody else's secret. A scheme that cannot tell those
apart is an error, because it is a door left open. Lanes that do not add up — `mcp_oauth` with no
MCP server, a paste lane with no `test_path` — are checked the same way. Everything runs against
the manifest alone, with no network and nothing stubbed, which is what lets the same function run
over every built-in connector in CI and over a file somebody is writing.

`webhook_signature: none` is a **warning, not an error**. Supabase's webhooks are Postgres triggers
with whatever headers you give them; Notion verifies with a token you copy once; Discord signs with
Ed25519, which is not this schema's shape. Those providers exist, and Perch accepts them with the
endpoint's unguessable URL as its only protection. Refusing them would mean no connector; saying
nothing would mean nobody knows. So it is said, once, in the harness and in the docs.

### Consequences
Six connectors join the four that shipped: Slack, Stripe, Linear, Notion, Sentry, Discord. Notion
and Discord carry `webhook_signature: none` with a comment saying exactly which scheme Perch would
need in order to do better, and Linear has no `test_path` because there is no call that would be
one — both surface as warnings rather than being hidden.

The rest of §5.5's seed list — Google Workspace, Jira, Cloudflare, Railway, Netlify, HeyGen, X — is
not here. A manifest is only worth what its endpoints are, and a guessed `test_path` fails at the
worst moment: after somebody has pasted a real credential. They are a follow-up task, one that
verifies each provider's endpoints and signature scheme against its documentation first.

Ed25519 webhook signatures are not supported. Adding them is a `webhook_signature` variant and a
verify branch, and Discord is the reason it will happen; it is not this task.

## ADR-0128: An api token's scopes are the grant on Perch's own MCP server

- Status: accepted
- Date: 2026-09-16
- Task: 3.12

### Context
§7.5 asks for "Perch's own MCP server at /mcp/perch (channels.list, messages.search,
messages.post, work.create, work.update, sessions.open, connections.call)" and §7.1 puts its auth
as "session, api token, or virtual key with a grant". Two of those three do not exist yet: virtual
keys are Phase 4, and a session's tool token is minted for a session rather than for a person.
What does exist is the api token of task 0.8, and it already carries exactly the scopes this
needs — `chat:read`, `chat:write`, `sessions:open`, `work:write`, `tools:call` — which were
written into `API_TOKEN_SCOPES` before there was anything to spend them on.

### Decision
**The scopes are the grant.** Each tool names one, and a token without it does not see that tool
at all: `tools/list` is filtered, not just `tools/call` guarded. An agent that cannot post should
not plan a post and discover at the end that it could not — the menu it is given is the menu it
has. `read` and `write` carry the narrower scopes and `admin` carries everything, the same
widening REST already does.

**A tool that will not run answers, rather than failing the call.** MCP has both: a JSON-RPC error
and a result with `isError`. A refusal an agent could do something about — a scope it lacks, a
channel that is not there — comes back as a result carrying Perch's own message (§7.8 writes those
for people), because an agent can read it and try something else. A JSON-RPC error would only tell
it the call broke.

**No workspace in the path.** `/mcp/perch` is one URL, as the spec writes it. A token made for a
workspace acts in that one; a token made for none acts in every workspace the person belongs to.
That is why `channels.list` spans workspaces and stamps each row with its own: it is the first
call an agent that was told nothing can make, and the ids it answers with are what every other
tool takes. A tool that genuinely needs one workspace and cannot pick — `messages.search` — says
so and lists the choices, rather than guessing.

**`connections.call` is gated by visibility, not by a per-subject grant.** The grants of §3.5 are
for bots and sessions, which act on somebody's behalf and must be told whose. An api token *is*
the person: it reaches the connections they could already use from the product — their own, and
the workspace's — and the gateway attaches the credential upstream exactly as it does for a
session, with the same audit row. Narrowing further would mean a person's own token could do less
through MCP than their browser can, for no gain.

### Consequences
Five of the seven tools §7.5 names ship. `work.create` and `work.update` are about work items,
which task 3.13 builds; `PERCH_TOOLS` is a list so that adding them there is an entry and a case,
and 3.13's line says so. Shipping a work tool now would mean designing work items inside 3.12,
which is the batching AGENTS.md §1.2 forbids.

`/mcp/perch` is registered before `/mcp/:connectionId`, which is safe because a connection id is
a uuid and `perch` is not one.

Virtual keys will be a third `callerOf` beside the session token and the api token, for every MCP
route at once, when Phase 4 builds them. Nothing here has to change to admit them.

## ADR-0129: The board follows the session, and a card's session settles

- Status: accepted
- Date: 2026-09-16
- Task: 3.13

### Context
§4 gives work items seven states, and two of them — `Running` and `Needs you` — are not states any
other tracker has. They are not opinions about the work; they are facts about an agent. A tracker
where somebody has to drag a card into Running the moment they start a session is a tracker that
is wrong most of the time, and 3.13's acceptance says as much: "closed by the session that
finished it".

### Decision
**One subscription, on `session.status`.** A coding session's own statuses are already the answer:
`running`, `needs_you`, `error`, `ended`. So the board reads them rather than keeping a second
opinion about the same thing — running → `running`, needs_you and error → `needs_you`, ended →
`in_review`. `idle` is deliberately not mapped: a session between turns has not moved.

**`ended` lands in `in_review`, never `done`.** An agent finishing is not a person agreeing. The
only thing that puts an item in `done` is somebody saying so, and an item already in `done` or
`cancelled` is never dragged back by anything on the bus — a person's word is the last one.

**A session opened from a work item settles by itself.** Task 2.18 made auto-settle a per-project
policy, on the reasoning that a background run should not hold a runner open for a conversation
nobody is having. A session opened from a card is exactly that run: it belongs to the card rather
than to somebody at a keyboard, and there is no route that ends a session by hand. Without this
the item would sit in `running` forever and the acceptance could not happen — the card would never
move. So `work_item_id` on a session is itself the auto-settle signal, whatever the project says.

**`KEY-123` is allocated in the insert.** The number comes from
`select coalesce(max(number), 0) + 1 … where project_id = $1` inside the `insert … returning`,
with the unique index as the arbiter and a retry when two writers read the same max. The
alternative — a sequence per project — is DDL at runtime for every project ever created.

**`cycles` and `modules` ship with the migration and nothing else.** `work_items` references them
by foreign key, and a shipped migration is never edited (AGENTS.md §7). Their tables exist; what
is built on them is a later task's.

### Consequences
`work.read` and `work.write` join §7.1's policy actions, both open to every member: a board is
what a team does together, and a member who can open a session can certainly move a card.

`work.create` and `work.update` complete the seven tools of §7.5 on `/mcp/perch`, which ADR-0128
left at five. An agent may name an item by its id or by `KEY-123`, because `KEY-123` is what a
person would have said to it.

A bot hears `work_item.updated` over the Bot API carrying the identifier, the title, the state and
which fields moved — not the item. A bot that cares reads it; a bot that does not should not be
handed it.

The board caps at 200 items and scrolls per column rather than virtualizing seven independent
lists. Past 200 the useful answer is a filter, not more cards; the cap is registered in
`scripts/perf-budget.ts` like the inbox's, so it cannot quietly go away.

## ADR-0130: A worktree belongs to a work item, and outlives no part of it

- Status: accepted
- Date: 2026-09-16
- Task: 3.14

### Context
§11's line for 3.14 asks for "one git worktree and one runner directory per work item, created on
assignment and removed on close, so two agents on one repository never share a checkout". Task 1.5
already built `worktree.create` and `worktree.remove` on the runner, and §7.6's `session.create`
already takes a `worktree` that decides the agent's cwd. What was missing was anybody asking.

### Decision
**A worktree is asked for by the session, not by the item.** `CreateSessionInput.worktree` names a
branch; `SessionService.create` makes the worktree on the runner *before* the row exists, so a
session that cannot get the directory it asked for has not started rather than started in the
wrong one. That puts the capability where race mode (3.16) will also want it, instead of inside
the board.

**"On assignment" means when an agent starts.** An item assigned to a person needs no worktree —
they work in their own checkout — and a directory with nobody in it is a directory for nothing. So
`startSession` is what asks, which is the moment an item is actually handed to an agent.

**`perch/key-123`, lowercased.** The branch is the identifier, and the worktree is named for the
branch. Lowercase because git refs are case-sensitive while a lot of filesystems are not, and
`KEY-123` and `key-123` being two branches that are one directory is a bad afternoon.

**A project with nothing to branch from still takes work.** An empty project is a repository with
no commits, and git cannot branch from a ref that does not exist. Rather than refusing to start the
item, `startSession` catches the refusal, says so in the log, and opens the session in the project
directory. The isolation is the point, but a board that cannot start an item on a fresh project is
worse than a board that occasionally shares a checkout.

**Closing gives the directory back; the branch stays.** `done` and `cancelled` remove every
worktree the item's sessions had. Removing the branch too would throw away commits nobody has
merged — a checkout is a place to work, not the work.

### Consequences
A session's row now reports `worktree`, `branch` and `work_item_id` over REST, which the session
pane and the Pull Requests page (3.20) both want: "which branch is this agent on" stops being a
question you answer by reading a diff.

Nothing changed on the runner. `worktree.create` and `worktree.remove` were built in 1.5 and are
used here exactly as §7.6 describes them, which is the first evidence that the protocol was worth
writing before there was a caller.

Two items on one project can now run at once. What they cannot yet do is land in order — that is
the merge queue, task 3.15.

## ADR-0131: The queue lands one branch at a time, and hands a failure back to its author

- Status: accepted
- Date: 2026-09-16
- Task: 3.15

### Context
Task 3.14 gave every work item its own worktree so three agents can write three branches at once.
That is only half an answer: three branches that were each written against yesterday's `main` do
not all apply to it. §5.7 asks for "merge queue with rebase, conflict detection, 'ask the agent to
resolve'", and §11's line for 3.15 for "three branches merge in sequence; the one whose checks fail
is sent back with the failure".

### Decision
**Serial per project, and the claim is the lock.** `claimNext` moves a row from `waiting` to
`landing` in one guarded update, so two api processes cannot both be landing on one project. The
loop runs while there is anything to land and stops when there is not, so an idle project costs
nothing — no worker, no timer, no queue table to poll.

**Checks before the merge, in the branch's own worktree.** A branch that is already broken should
not move the base at all, and rebasing it first would only tell us about the merge. "The project's
checks" is the first of `check`, `test`, `ci` or `verify` in `.perch/project.json`'s `run` map — a
project that names none is a project with no checks, and its branches land on git alone.

**`exec` was already in §7.6.** It was declared with the rest of the protocol in task 1.5 and
implemented there too; what was missing was a caller. The merge queue is the first thing that
needed to run a command and wait for its exit code, and it uses `exec` exactly as §7.6 writes it.

**`git.merge` is the one new method.** Rebase and fast-forward have to happen as one operation on
the runner: two of them racing from the api side is precisely what a queue exists to prevent. The
rebase runs in the branch's own worktree, because git will not rebase a branch that is checked out
somewhere else and after 3.14 it usually is. `worktree.create` became idempotent in the same
change — asking twice is now asking where a branch is, which is how the queue finds the directory
to run checks in.

**A failure is the author's, not the queue's.** A branch that conflicts or fails its checks is
marked `failed` with git's own words or the tail of the command's output, its work item goes to
`needs_you`, and the session that wrote it is sent a turn saying what broke. Then the queue moves
on to the next branch. A queue that stops at the first red branch is a queue that one agent can
hold hostage.

**`merge.*` are four additive bus events** (ADR register in `packages/events/test/events.test.ts`):
§5.7 names the queue and not its events, and a queue nobody can watch is a queue you have to poll.

### Consequences
`queue_card` joins §5.2's blocks: one card per entry in the work item's thread, rewritten in place
through the same `updateMessageBlocks` path a streaming reply uses, with no edit history — the
queue is rewriting its own status line, not editing somebody's message.

A branch that lands takes its work item to `in_review`, not to `done`. That is the same rule
ADR-0129 set: an agent finishing, or a merge succeeding, is not a person agreeing.

What is not here: the queue does not push. It lands on the runner's checkout, and getting that to
a remote is the Pull Requests page's business (3.20) and `ship()`'s. Nor does it re-queue a branch
whose agent has fixed it — the agent is asked, and somebody puts it back in the queue. Doing that
automatically is the testing loop, task 3.18.

## ADR-0132: A race is several ordinary sessions and one decision

- Status: accepted
- Date: 2026-09-16
- Task: 3.16

### Context
§5.7 asks for "the same task on two engines/models side by side; compare diffs, cost, preflight;
pick a winner", and §11's line for 3.16 for "a race finishes with one diff applied and the rest
discarded". The question is how much of that is new machinery.

### Decision
**Almost none of it is.** An entrant is an ordinary coding session in an ordinary worktree (task
3.14), the checks are the merge queue's checks (task 3.15), and the winner lands through the queue
like any other branch. What race mode adds is two tables, a comparison, and a decision. The
alternative — a parallel path that runs engines outside the session lifecycle — would have had to
re-earn permissions, budgets, transcripts and cancellation, all of which sessions already have.

**Every entrant's row goes in before any of them is asked anything.** A round can finish inside
`sendTurn` — a fast engine, a cached answer, a fake one in a test — and two things break if the
bookkeeping is written afterwards. An entrant with no row yet cannot be found when its session
ends, so it never finishes; and a race whose other entrants do not exist yet looks over after the
first one comes back, and gets decided on a field of one. So the rows are written first, then each
session is created, given its id, and only then asked.

**Two to eight.** One engine is a session, not a race, and `POST …/races` says so with a `422`.
Eight is a number rather than a principle: a race is a comparison somebody reads, and past eight
rows nobody is comparing.

**The checks decide when nobody has.** When every entrant has finished and the project has checks,
the cheapest entrant whose checks pass wins, with the smallest diff breaking a tie: a race is won
by the answer that works, and among those by the one that asked for the least. A project with no
checks never decides by itself — there is nothing to prefer one diff over another, and guessing
would be worse than waiting for a person. `decided_by` records which it was.

**The winner's diff is applied by landing it, not by copying it.** `decide()` puts the winning
branch in the merge queue, which rebases and fast-forwards it exactly as it would any other branch,
so a race winner meets the same checks and the same serialization as everything else. Every other
entrant is `discarded`: its worktree is given back, its branch stays. A branch with commits on it
is still there when somebody wants to look at what the engine that lost was thinking.

**`race.*` are three additive bus events** (ADR register in `packages/events/test/events.test.ts`),
for the same reason `merge.*` were: §5.7 names the feature and not its events, and a race nobody
can watch is a race you have to poll.

### Consequences
`race_card` joins §5.2's blocks: one card per race in the item's thread, rewritten in place, with
a row per engine carrying what it changed, what it cost and what the checks made of it — and a
**Pick** on each row while the race is open. The comparison is the card, because the decision is
one glance across four numbers rather than four cards to hold in your head.

A race that is about a work item takes it to `in_review` when it is decided, the same rule
ADR-0129 and ADR-0131 set: an engine winning is not a person agreeing.

What is not here: a race cannot be re-run, and a person cannot edit a winner's branch before it
lands — they pick, and then it is an ordinary branch in an ordinary queue. Cost comes from the
session's own usage, so an engine that does not report usage races with a cost of zero and wins
ties it should not; that is the engine's gap rather than the race's, and it shows on the card as
`$0.00` rather than being hidden.

## ADR-0133: A session that nobody is sitting in front of says so

- Status: accepted
- Date: 2026-09-16
- Task: 3.16

### Context
Task 3.13 made a session opened from a work item settle when its round goes quiet: it belongs to
the card rather than to a person at a keyboard, and its ending is what moves the card to review.
That rule was written as `session.workItemId !== null`. Task 3.16 needs the same behaviour for a
race entrant, which may have no work item at all — a race can be started from a bare prompt.

### Decision
**`coding_sessions.unattended`, a boolean, replaces the inference.** The rule was never really
about work items; it was about whether anybody is waiting at a keyboard for the next turn. A
session that the board or a race opened is machinery, and machinery lets go of its runner when it
is done. `create()` defaults it to `true` when a work item is given, so 3.13's behaviour is
unchanged without any caller having to know about the column, and the migration backfills existing
rows the same way.

An entrant that never ends is worse than a held runner: its ending is what gets it measured and
compared, so a race of idle sessions is a race that never finishes.

### Consequences
Auto-settle now reads `background.autoSettle || session.unattended`. A project's own auto-settle
policy (task 2.18) still applies to everything, including sessions a person opened. Anything that
starts a session on somebody's behalf in a later task — the testing loop, a scheduled run — says
`unattended: true` and gets the same lifecycle for free rather than growing another special case.

## ADR-0134: A background run is one card, and the phone hears only what needs a person

- Status: accepted
- Date: 2026-09-16
- Task: 3.17

### Context
§5.7 asks for "background by default: sessions keep running when the tab or laptop closes; every
state change posts to the task's thread; the phone gets what needs a human", and §11's line for
3.17 for "a background session finishes overnight and its card is the whole story".

The first clause was already true and always had been: a session runs on the api, driven by the
round loop in `SessionService`, and a browser is a viewer. Closing a tab has never stopped one, and
the acceptance test proves it by never opening a WebSocket at all. So this task is the other two
clauses.

### Decision
**One card, rewritten in place.** Not a message per event. A run that says four things overnight is
four notifications to scroll past in the morning; a run that keeps one card is a thing you read.
The card carries what it was asked, where it got to, the tool it is waiting on, and — once it is
over — turns, tool calls, files changed, cost and elapsed time. `coding_sessions.card_message_id`
is where it lives, the same way a race and a queue entry each carry theirs.

This is the third feature to want a card rewritten in place (3.15, 3.16, now 3.17), and all three
use the same `updateMessageBlocks(..., {history: false})` path a streaming reply uses. A machine
rewriting its own status line is not somebody editing a message, so it leaves no edit history.

**The counts come out of the transcript, not a second ledger.** Tool calls, files touched and the
last thing it said are folded out of `session_events` when the card is written. The transcript is
already the record; anything else would be a copy of it that can disagree with it.

**`background.notify` decides what reaches a phone**, per project, in `.perch/project.json` beside
`unattended` and `autoSettle` (task 2.18): `needs_you` (the default — a permission it is stuck on,
or a failure), `always` (those plus the finish), `never`. `needs_you` is the default because that
is the whole promise: a run getting on with it is a card to read later, and a run that is stuck is
somebody's evening. One notification per state per session, tagged `session:<id>`, so an evening of
state changes replaces itself on the lock screen instead of stacking up.

**A channel is required.** `POST …/sessions/background` takes `channel_id` and refuses without it
(`422`). A background session with nowhere to report is a session nobody will ever read, and
defaulting it to some channel would be a guess about whose attention this deserves.

### Consequences
`background_card` joins §5.2's blocks. The finish line is ADR-0133's: the session is `unattended`,
so it settles when its round goes quiet, and the card's `done` and the session's `ended` are the
same moment rather than two things that can drift apart.

Push reuses task 2.3's `notify()` and its vault-held VAPID keys, so a laptop-mode Perch wakes a
phone with no configuration — and a push that fails is a notification somebody misses, never a run
that fails.

What is not here: no schedule (a run every night at two is cron, task 3.5's, pointed at this
endpoint), no budget ceiling of its own (the policy engine's, task 2.11), and no digest of several
runs. The approval inbox already collects what needs a person across features (task 2.10); this
adds the card, not a second queue.

## ADR-0135: The tests run at the end of a round, and the loop is short

- Status: accepted
- Date: 2026-09-16
- Task: 3.18

### Context
§5.7 asks for a "testing loop: failing tests → bounded auto-fix loop with budget", and §11's line
for 3.18 for "an agent breaks a test, is told, and fixes it without anybody typing".

### Decision
**It hooks the end of a round, not the bus.** Every other feature in this phase subscribes to
`session.status` and works from there. This one cannot: an unattended session settles the moment
its round goes quiet (ADR-0133), and a session that has ended cannot be told anything. So
`SessionService` gained one seam — `onRoundEnd`, which answers whether something is about to send
another turn — and auto-settle waits for that answer. The loop is the only thing that sets it
today.

It runs only for a round that finished **cleanly**. An agent that errored, or one parked on a
permission, has a different problem from a failing test, and telling it about the tests would bury
the real one.

**Off unless the project asks.** `background.testLoop` absent means off. A suite after every turn is
somebody's bill and, in a session a person is sitting in, a surprise turn they did not type. It is
also the third place a project's checks could run — the merge queue holds branches to them (3.15)
and a race measures its entrants with them (3.16) — and a third one running automatically, on
everything, would be surprising rather than helpful.

**Only after a round that wrote something.** The transcript says whether it did: a `tool_result`
carrying a diff since the last turn. A round that answered a question has nothing to test.

**Two attempts, and then a person.** `attempts` defaults to 2 and is capped at 5.
`coding_sessions.fix_attempts` counts them and a passing run resets it, so the count is per problem
rather than per session. When it runs out the session is parked at `needs_you` with the failure as
its status message, which is where both the inbox (2.10) and the background card (3.17) already
look. An agent that cannot fix what it broke in two goes will not fix it in five, and each go is
real money.

**`exec` gained an optional `project`, and its `cwd` became optional.** §7.6 writes
`exec {command, cwd, timeout}`, which obliges the caller to know which directory a project is in.
The merge queue and race mode both had one to hand from `worktree.create`; a session working in the
project checkout does not, and the api would have had to reconstruct the runner's own directory
layout to say so. Naming the project instead keeps that knowledge on the runner, where it belongs.
`cwd` still wins when both are given, so every existing caller is unchanged.

### Consequences
Spec deviation: `exec`'s params, as above. Recorded here and noted in the commit.

The failure the agent sees is the tail of the command's output, capped, and the turn says "do not
change the tests to make them pass" — the one obvious way to satisfy a test loop is to delete the
test.

What is not here: no flaky-test detection (a test that fails once and passes once is still a
failure to this), and no CI-status webhook retry — §5.7 names both, and both belong with the Pull
Requests page (3.20) where a CI run is a thing Perch can see. The loop also does not commit what it
fixed: a session's changes land the way any session's changes land.

## ADR-0136: The floor is the two tables that already know, and Stop is one button

- Status: accepted
- Date: 2026-09-16
- Task: 3.19

### Context
§5.7 asks for "agent presence: busy/idle, 'working on' cards, agent org view, assignment from
chat", and §11's line for 3.19 for "three agents working show three rows, and stopping one stops
it".

### Decision
**No register.** A running coding session is a row in `coding_sessions` with a status; a running
bot is a row in `bot_runs` with a status. Reading both is the list. The tempting alternative — an
in-memory registry every feature reports into — is a third source of truth whose only distinctive
property is that it can be wrong about what is running, and it would be empty after a restart while
the sessions it forgot were still going.

**One endpoint for Stop, whatever the row is.** `POST …/agents/{kind}/{id}/stop` rather than the
caller choosing between a session's cancel and a bot's. The person is looking at a list of things
working, each with one button; making the client know which sort of thing each row is would be
pushing a detail of our schema into their hand. Underneath it is still the session's own cancel and
the bot's own abort.

**A bot's stop reaches the model call.** `BotsService` now keeps an `AbortController` per run in
flight and passes its signal to `runBot`, which already accepted one and had never been given it.
Marking the row and letting the run carry on would be a lie told to somebody watching their bill.
A stopped run finishes as `error` with "stopped by a person", so the row says which it was.

**Stopping something already finished is `{stopped: false}`, not a `404`.** The race between a
person's finger and an agent finishing is ordinary, and an error would make the UI apologise for
something that is not wrong.

**`agent.stopped` is an additive bus event** (register in `packages/events/test/events.test.ts`):
stopping an agent is a state change, so the audit log hears about it by subscribing like everything
else, rather than a feature writing to the audit log directly (AGENTS.md §5).

**It lives in Bots mode's sidebar.** That is §5.7's "agent org view", and it is workspace-wide,
which is the difference from Code mode's Sessions section — that one is a project's sessions,
including the idle ones you might go back to. This one is only what is working, anywhere. A
rail-wide indicator that follows you between modes is §4's business and not this task's.

### Consequences
The list is live off the workspace topic — `session.*`, `bot.run_*`, `agent.stopped` — with a ten
second poller behind it, because a list that is quietly wrong about what is running is worse than
one that is a few seconds late.

Reading the floor needs `sessions.read` and stopping needs `sessions.create`: the right that opens
a session is the right that closes one. Somebody outside the workspace gets a `404` rather than a
`403`, so they do not learn how many agents are working either.

What is not here: "assignment from chat", which §5.7 names in the same breath — that is the board's
(3.13) and the orchestrators' (3.10). Nor a history of what has been stopped; `bot_runs` and the
audit log both keep that already.

## ADR-0137: Pull requests are the connection's, and the push is the reply

- Status: accepted
- Date: 2026-09-16
- Task: 3.20

### Context
§5.1 asks for a "Pull Requests page in Phase 3 with inline comments, request changes, 'ask the agent
to address review'", and §11's line for 3.20 for "a review comment becomes a turn and the push
answers it". Task 1.20 already opens one; this is reading and answering them.

### Decision
**No `pull_requests` table, and no cache.** Every read goes to the provider on the connection's own
delegated token. A copy in Perch would be a second answer to "what does this review say", and it
would be wrong from the moment somebody comments in the provider's own UI — which is where most
reviews are still written. The cost is a round trip per page; the alternative is a page that
confidently shows yesterday's review.

**Three calls for one pull request**, not one: the pull request, its review comments, and the checks
on its head commit. Checks hang off the commit rather than the pull request, so a pull request whose
head moved has different checks from the one you were reading — folding them into one call would
mean pretending otherwise. Checks failing to load is a warning rather than an error: a repository
with no checks answers this differently on every provider, and a pull request is still readable
without them.

**The push is the reply.** "Ask the agent to address it" opens a session on the pull request's own
branch, hands it the review as its first turn — every comment with its file and its line — and tells
it not to reply in the pull request. Perch posting a comment on the agent's behalf would put a
message in a reviewer's inbox that contains no change; the commit that answers them is the answer.

**A branch that is not here is a `422`, not a best effort.** `worktree.create` makes a branch from
the base when it does not find one, so addressing a pull request whose branch this checkout has never
seen would silently give the agent an empty branch cut from `main` — which looks like it is working.
The service asks `git.branch` first and refuses by name. Fetching it instead is a real improvement
and needs a `git.fetch` in §7.6; that is not this task.

**Requesting changes without saying why is a `422`.** The provider would accept it. A request for
changes that does not say what to change is not a request, and the person who wrote it will be asked
anyway.

**`PullRequestDetail`, not `PullRequest`.** 1.20 already registered `PullRequest` as the shape
returned when one is opened. Two schemas under one component name silently keep the first, which is
how the generated client ended up typed as the wrong thing until the collision was noticed.

### Consequences
The page is a drawer tab in Code mode beside Git, Deploy and the database browser, lazily loaded:
it only matters once there is a connection and something to review, and most sessions never open it.

The connection is chosen per request rather than stored on the project. A project can be reachable
through more than one connection (a person's and an app's), and which one a review is submitted as
is a decision worth making explicitly.

What is not here: replying to a single inline comment (the push answers the review as a whole),
resolving a thread, merging from Perch, and requesting a reviewer. Merging especially: the merge
queue (3.15) lands branches on the runner's checkout, and a "Merge" button on this page would be a
second, different way to land something.

## ADR-0138: A tweak changes the page first and the file only when asked, and refuses rather than guesses

- Status: accepted
- Date: 2026-09-16
- Task: 3.21

### Context
§5.6 asks for "Direct tweaks (Phase 3): edit text, classes, common CSS in the panel → applied
instantly → written to source via a deterministic `apply_element_edit` tool → diff card".

### Decision
**Two halves, deliberately unequal.** Typing in the panel changes the page on every keystroke, and
nothing is written anywhere. **Write to source** is a separate press. Looking at a thing is cheap
and editing somebody's repository is not, and a tweak that wrote a file per keystroke would be a
hundred commits' worth of churn for one decision.

**Deterministic means it is given the position, not asked to find it.** `data-perch-src` already
carries `file:line:column` for the `<` that opens the element (task 2.16), so the caller never names
a file. Everything that makes this hard — "which `<div className="p-2">` did they mean" — was solved
by the tagger, and the edit is a pure function over a file and a position. `applyElementEdit` lives
in `@perch/inspector` with no I/O in it at all, which is why it can be exhaustively unit-tested.

**It refuses more than it attempts.** `className={cn(a, b)}` is not a string to rewrite; an element
holding a child element has no "the text"; a position the file has moved on from is not that element
any more. Each refusal is a `422` carrying its reason, because a reason is something the panel can
show and an agent can work around, and a guess is a wrong edit in somebody's repository. The scanner
is the tagger's, not a parser: a JSX toolchain in the api to change one attribute would be a large
dependency bought to make the failure mode worse.

**Common CSS reaches source as classes.** §5.6 names "text, classes, common CSS". In a
Tailwind-shaped project — which is what §5.6's "classes (Tailwind-aware)" assumes — a CSS tweak *is*
a class change, and that is the edit this writes. Writing an inline `style={{…}}` into somebody's
JSX is a different and worse change than the one they made in the panel, so it is not offered.

**Whitespace survives.** An element written over three lines keeps its indentation: only the trimmed
text is replaced. JSX collapses it either way, and reflowing a file to change one word makes a diff
nobody wants to read.

### Consequences
The endpoint returns the diff of the one file, computed here rather than asked of git: the working
tree may have other changes in it, and this card is about the one edit just made.

It goes through `projects.update` and the runner's own policy hook — writing a file is writing a
file, whoever pressed the button — so a protected path is protected from the panel exactly as it is
from a session.

What is not here: the same edit as an agent tool on `/mcp/perch`. The service is shaped for it
(`editElement` takes a project and a link and nothing web-shaped), and the tool belongs with the
rest of the agent's eyes rather than with the panel's hands.

## ADR-0139: A session's MCP servers can be spawned, and the browser's command is the operator's

- Status: accepted
- Date: 2026-09-16
- Task: 3.21

### Context
§5.6 asks for "Agent eyes: @playwright/mcp in the runner attached to sessions when a preview is
open (navigate, accessibility snapshot, screenshot, click, console)". §7.6's `session.create` carries
`mcp_servers`, and task 1.17 defined that as `{name, url, token}` — Perch's own gateway, reached over
HTTP with a token minted for that session.

### Decision
**`mcp_servers` becomes a union: the HTTP shape, or a command.** Playwright's server drives a
browser, and the browser has to be where the page is — on the runner, next to the dev server it is
looking at. There is nothing for the api to serve over HTTP, and proxying a browser's control
channel through Perch to reach a process on the same machine as the page would be an elaborate way
to make it slower. ACP already has both transports (`McpServerHttp`, `McpServerStdio`), so the
runner maps each onto the one it means.

Spec deviation: §7.6 writes `mcp_servers` with the HTTP fields. The union is additive — every
existing caller and every existing server is unchanged — and recorded here.

**The spawned shape carries no credential**, and says so in the schema. An HTTP server's token is
Perch's own, minted per session and scoped; a command line is a command line on a machine Perch does
not own, and putting a secret in one would put it in that machine's process list.

**The command is configuration, not a pinned dependency.** `PERCH_PLAYWRIGHT_MCP` names it and unset
means off. Which build of `@playwright/mcp` matches the browser in a given runner image is that
operator's decision; Perch shipping `npx -y @playwright/mcp@latest` would be Perch choosing a package
manager, a network fetch and an unpinned version inside somebody else's container. The hosted image
sets one; `.env.example` shows the shape.

**"A preview is open" means the project's own configured port.** Not any listening port: a runner has
other things listening, and Perch would not know which of them is the page — the in-process runner
sees the whole machine, which is how the first version of this test failed. A session with nothing to
look at gets no browser, because a process and a context window spent on nothing is worse than no
tool, and an agent offered tools that cannot work is an agent that will try them.

### Consequences
The eyes are attached per round rather than per session, so a preview that comes up mid-session is
seen by the next turn — the same rule the rest of `mcpServers` already follows.

A failure here costs a session its eyes, not its turn: `mcpServers` has always swallowed its own
errors, and an agent that cannot look at the page is still an agent.

What is not here: Perch does not check that the command exists. A misconfigured one fails when the
agent tries it, in the agent's own words, which is where an operator will be looking.
