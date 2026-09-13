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

## ADR-0035: Spike 0.4.7 — dockerode from Bun is verified in CI, not in the build environment

- Status: accepted (spike outcome: deferred to CI)
- Date: 2026-09-13
- Task: 0.4.7

### Context
Spec §9.3: the supervisor creates, limits, execs into, and removes a runner container; the fallback is a
supervisor on Node LTS in its own image. The Phase 0 build environment has no Docker daemon.

### Decision
The spike is written and skips without a daemon; `.github/workflows/spikes.yml` runs it on the ubuntu runner
(pull, create with NanoCpus/Memory/PidsLimit, start, exec, stop, remove, nothing left behind). Task 1.2
reads that result before implementing the supervisor and takes the Node LTS fallback only if CI fails.

### Consequences
The supervisor entrypoint stays in `apps/api` (Bun) pending the CI outcome; the fallback would move it to
its own image without changing the runner protocol.

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
