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
stops when its stdin closes, so the server never outlives the window). A Bun worker thread was the
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
