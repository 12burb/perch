# TASKS

The queue. Take the first unchecked task whose prerequisites are checked (spec §11; one task per branch, one
branch per PR). Phases 3 and 4 are written at the phase gates from spec §10.

Legend: `[ ]` open · `[~] <branch>` in progress on that branch · `[x] <PR link>` merged.

## Phase 0 — Foundation

- [x] **0.1** Repo scaffold: Bun workspaces, Turborepo, Biome, strict TS, Changesets, Renovate, PR and issue templates, LICENSE (AGPL-3.0) + MIT licenses in bot-sdk, ui, events, api-client, connectors, templates (CI green on the empty monorepo) — commit `feat(scaffold): bun workspaces, turborepo, biome, strict ts, changesets, renovate` (ADR-0018)
- [x] **0.2** Governance files per §9.2 (all present; DCO check enforced) — commit `docs(governance): readme, contributing, conduct, security, governance, pledge, dco check`
- [x] **0.3** Dependency resolution: exact package names and versions for §2 from official docs, pinned; DECISIONS entry per non-obvious pick (lockfile committed) — commit `chore(deps): resolve and pin the §2 stack` (ADR-0019..0028)
- [x] **0.4** Spikes from §9.3, one PR each, outcomes in DECISIONS.md ∥ (every spike has a recorded pass or fallback) — commit `feat(spikes): phase 0 spikes with recorded outcomes` (ADR-0029..0038; `spikes/README.md`)
  - [x] **0.4.1** PTY on Bun — fallback: bun-pty (ADR-0029)
  - [x] **0.4.2** ACP handshake — pass (ADR-0030)
  - [x] **0.4.3** OpenCode SDK — pass, streamed reply gated on a key (ADR-0031)
  - [x] **0.4.4** PGlite — pass (ADR-0032)
  - [x] **0.4.5** QuickJS sandbox — pass (ADR-0033)
  - [x] **0.4.6** better-auth on Bun — pass at the HTTP level; browser passkeys in 0.8 (ADR-0034)
  - [x] **0.4.7** dockerode from Bun — deferred to CI (ADR-0035)
  - [x] **0.4.8** Caddy wildcard — deferred; path mode is the default (ADR-0036)
  - [x] **0.4.9** Preview tunnel over a local runner — pass (ADR-0037)
  - [x] **0.4.10** cloudflared profile — deferred; Tailscale documented (ADR-0038)
- [x] **0.5** packages/db: Drizzle schema for identity, tenancy, projects, runners, channels, messages, files, instance_settings; Db factory for postgres and pglite; migrations; PGlite test harness (schema tests pass on both drivers) — commit `feat(db): drizzle schema, db factory, embedded migrations, pglite harness` (ADR-0039, ADR-0040)
- [x] **0.6** packages/events, bus, jobs, vault with unit tests (queue survives worker crash, cron fires, vault round-trips and rotates) — commit `feat(core): events catalog, in-process bus, postgres job queue, vault` (ADR-0041)
- [x] **0.7** apps/api skeleton: Hono + zod-openapi, error model, request logging, health, version, OpenAPI at /api/openapi.json, generated TS client (GET /api/health typed end to end) — commit `feat(api): hono skeleton with openapi, error model, request logging, typed client` (ADR-0042, ADR-0043)
- [x] **0.8** Auth: better-auth with Drizzle adapter, email+password, passkeys, generic OIDC, users profile row, invites, api_tokens (Playwright: sign up, sign in with passkey, invite accepted) — commit `feat(auth): better-auth with passkeys and OIDC, profiles, invites, api tokens` (ADR-0044..0050; `bun run e2e`: e2e/auth.e2e.ts, 6 passed at 1440 px and 390 px)
- [x] **0.9** Workspaces, memberships, RBAC, authorize() middleware, audit log via bus (member cannot read another workspace; audit rows appear) — commit `feat(workspaces): rbac with authorize(), members, and the audit log via the bus` (ADR-0051..0053; apps/api/test/workspaces.test.ts, packages/policy/test/authorize.test.ts)
- [x] **0.10** WS server: subscribe, resume with seq, presence, typing (two tabs see each other's presence; reconnect replays) — commit `feat(ws): /api/ws with subscribe, resume, presence, and typing` (ADR-0054; apps/api/test/ws.test.ts; e2e/presence.e2e.ts)
- [x] **0.11** packages/ui: tokens, dark and light themes, shadcn base, Shell, Rail, Sidebar, Panel, Drawer, CommandPalette, Peek, Composer skeleton (Playwright component tests; axe passes) — commit `feat(ui): tokens, themes, shadcn base, and the shell components with component tests` (ADR-0055; `bun run ct`: packages/ui/src/**/*.ct.tsx)
- [x] **0.12** apps/web shell: routes for the six rail tabs, mobile tab bar, empty states, profile and workspace settings (390 px and 1440 px screenshots in the PR) — commit `feat(web): the shell with six modes, mobile tab bar, empty states, and settings` (ADR-0056; e2e/shell.e2e.ts; screenshots in docs/screenshots/0.12)
- [x] **0.13** Deploy: Dockerfile.api, Dockerfile.runner base, compose, Caddyfile, `perch init`, setup wizard (admin, workspace, PERCH_PUBLIC_URL, telemetry checkbox) (fresh Ubuntu VM: docker compose up → wizard → sign in) — commit `feat(deploy): dockerfiles, compose, caddy, perch init, and the setup wizard` (ADR-0057, ADR-0058; apps/api/test/setup.test.ts, apps/cli/test/init.test.ts, e2e/00-setup.e2e.ts; the compose smoke on a fresh VM runs in CI, task 0.15)
- [x] **0.14** apps/cli skeleton: perch dev on PGlite with in-process runner stub, perch doctor, perch backup|restore (laptop smoke test in CI on Linux, macOS, Windows) — commit `feat(cli): perch dev on PGlite with the in-process runner, doctor, backup, and restore` (ADR-0059; apps/cli/test/laptop.test.ts is the laptop smoke; the macOS and Windows legs run in CI, task 0.15)
- [ ] **0.15** CI pipeline per §8 including multi-arch image publish on tag and cosign (a tagged pre-release publishes signed images)

## Phase 1 — IDE core

- [ ] **1.1** apps/runner control channel: register, heartbeat, capability token verification, hosted mode in the runner image (a launched runner registers within 5 s)
- [ ] **1.2** Supervisor: dockerode lifecycle, limits, idle stop, per-user home volumes, shared mode (two workspaces get two containers; idle stop works)
- [ ] **1.3** Local runner: perch runner connect with a minted token, owner-only access, Environments page (a laptop registers and shows online from a phone)
- [ ] **1.4** Projects: create empty, upload, clone via HTTPS token or SSH deploy key; project volume; .perch/project.json read and validated; devcontainer.json honored (clone a public repo; defaults applied)
- [ ] **1.5** Runner fs, git, ports, exec methods with policy hooks (fs.search under 200 ms on a 50k-file repo)
- [ ] **1.6** Code mode: file tree, EditorGroup with CodeMirror 6, tabs, breadcrumbs, search/replace, markdown and image preview (open, edit, save, reopen)
- [ ] **1.7** Terminal: pty.open streams, xterm.js drawer, tmux persistence, per-user shells, path links open in the editor (reload keeps the shell)
- [ ] **1.8** packages/engines: Engine interface, EngineEvent persistence, session lifecycle, session_events replay endpoint (unit tests with a fake engine)
- [ ] **1.9** ACP adapter: spawn registry agents, map events, permissions, modes, MCP passthrough for Perch tools (Gemini CLI and Codex complete a two-turn session with one permission prompt)
- [ ] **1.10** OpenCode adapter: opencode serve per project, SDK client, plan/build, subagents (a session edits a file and the diff arrives as EngineEvents)
- [ ] **1.11** cli-harness adapter behind a feature flag: Codex exec --json and Claude Code -p --output-format stream-json (flag off; both work in a local runner under the owner's login)
- [ ] **1.12** Session pane: Composer in session mode, streaming transcript, tool cards, PermissionPrompt, usage footer, session list, fork, rename (Playwright: plan → build → permission → done)
- [ ] **1.13** DiffView: per-turn and cumulative diffs, hunk accept/reject, Accept all / Reject all, Restore checkpoint, Apply on code blocks (accept two hunks, reject one, restore turn 1)
- [ ] **1.14** ⌘K inline edit in the editor (select, instruct, diff in place, accept)
- [ ] **1.15** Brains v1: credentials vault UI, model profiles, catalog seeded from models.dev, endpoint providers including Ollama auto-detect, model picker (an OpenAI key and an Ollama endpoint both run a session)
- [ ] **1.16** Connections v1: packages/connect core, manifest schema, token paste, OAuth callback route, CIMD document, GitHub App wizard and connector (clone via GitHub connection → PR opened)
- [ ] **1.17** MCP gateway skeleton: /mcp/{connectionId} proxy with token injection, allow-lists, audit; GitHub's MCP through a PAT connection exposed to an ACP session (agent lists issues; PAT never appears in the runner)
- [ ] **1.18** Preview v1: port discovery, path-mode proxy, wildcard mode behind Caddy, WS passthrough, Preview tab (URL bar, viewport presets, reload, open in new tab), preview block in project config, share links (Vite HMR works in both modes; a share link opens without the inspector)
- [ ] **1.19** Preview tunnel over local runners via http.open (HMR through a laptop runner from a phone)
- [ ] **1.20** Git panel: status, stage, commit with AI message, branch, push, Open PR (commit and PR from the panel)
- [ ] **1.21** Laptop mode parity: perch dev runs 1.4–1.20 in-process on PGlite (laptop smoke extended to a full session)
- [ ] **1.22** Phase 1 e2e: the exit criterion as one Playwright spec on a paid key, on Ollama, through OpenCode, and through ACP (four green runs)

## Phase 2 — Chat, bots, the loop's front half

- [ ] **2.1** Channels: public, private, DMs, groups, item threads; membership; header; archive; sidebar sections with unread weight (Playwright: create, join, leave, archive)
- [ ] **2.2** Messages: blocks, edit history, delete, threads with reply counts, hover toolbar, pins, bookmarks, read state, mentions with autocomplete for people, bots, groups, channels, work items, files (Playwright covers each)
- [ ] **2.3** Reactions, files with previews, unfurls for Perch identifiers, web push (push arrives on a phone for a mention)
- [ ] **2.4** Search: full-text over messages and files with filters; results page with peek (under 150 ms on 100k messages)
- [ ] **2.5** Interactive blocks: BlockRenderer for button, select, form, approve_deny, progress; interaction.received delivery; in-place update (a bot's approve button updates the message and the bot gets the payload)
- [ ] **2.6** Native bot runtime: triggers, tool registry (web_search, http_fetch, chat_post, chat_read, remember, recall, thread_facts), streaming replies with placeholder edit, budgets, rate limits (a template bot answers a mention within budget)
- [ ] **2.7** Bot-to-bot mentions: mention, wait_for_replies, hand_off, chain tracking, hop limit, repeat-pair breaker, per-thread budget, ChainHeader, intervene card (three bots complete a fan-out; a ping-pong pair trips the breaker)
- [ ] **2.8** Forge UI level 1: form, live test chat, publish to channels, the six templates; bot skills/ in the Agent Skills format (create Grok Newsroom; @grok answers in #general)
- [ ] **2.9** DM-a-bot with model picker and New chat threads (fresh context per thread)
- [ ] **2.10** Inbox: inbox_items from permissions, chains, budgets, mentions; InboxList, resolve, snooze, batch approve; mobile launch tab (approve a session permission from the inbox on a phone)
- [ ] **2.11** Policy engine v1: policy.yaml schema, evaluator, protected branches, denied commands, path lists, model allow-lists per channel and project, budget ceilings, violation cards, dry-run endpoint (a local-only channel refuses a cloud profile; git push --force is blocked)
- [ ] **2.12** Secret scanning on agent diffs before commit (a planted key blocks the commit with a card)
- [ ] **2.13** Project env and secrets: encrypted env, injection into runner, sessions, previews (a session sees DATABASE_URL; it never appears in a transcript)
- [ ] **2.14** Connections v2: MCP OAuth with CIMD, DCR, pre-registered; BYO OAuth wizard; Vercel, Supabase, Clerk connectors; connection test; grants UI; on-behalf-of rule (Supabase MCP connects via DCR; a shared bot is refused a personal connection)
- [ ] **2.15** Deploy button and DB panel: Vercel deploy from the IDE with preview URL card; Supabase schema browser, read-only by default (deploy posts its preview URL in a thread)
- [ ] **2.16** Inspector v1: @perch/inspector plugins (Vite, Next, Webpack), injected client, Elements tree, select → context chip, console and failed requests strip with Send to agent, screenshot to thread via Playwright in the runner (click a button → "make this primary" lands the right edit)
- [ ] **2.17** Repo intelligence v1: repo_index chunking and embeddings on a job, @codebase context, semantic search across code and chat, AGENTS.md draft generator (an @codebase question cites the right file)
- [ ] **2.18** Custom actions, reasoning level, background and auto-settle policies per project (a custom action runs from the session pane and from ⌘K)
- [ ] **2.19** Bot API v1: endpoints and socket mode per §7.3 with scopes and rate limits; bot-sdk published (an external script posts a message and receives an app_mention)
- [ ] **2.20** Perf audit script in CI: WS payload budget, bundle size budget, list virtualization check (budgets enforced)
- [ ] **2.21** Phase 2 e2e: the exit criterion as Playwright specs; axe sweep on Home, Code, Inbox (all green)

## Phase 3 — Bot platform + the loop

Written at the Phase 2 gate (spec §10) and reviewed by the human before starting.

## Phase 4 — Gateway, hardening, launch

Written at the Phase 3 gate (spec §10) and reviewed by the human before starting.
