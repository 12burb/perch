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
