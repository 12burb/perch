# Phase 3 report

Every Phase 3 task (spec §10's Phase 3 line, written out as 3.1–3.26 in
[`../TASKS.md`](../TASKS.md)) is `[x]`. Work landed on `main` as one DCO-signed conventional commit
per task (ADR-0065), with CI on `main` as the gate after the fact and the same local gate a pull
request would have had before every push.

## The exit criterion

> `@dawn fix X` from chat ships a diff card and a PR; three agents work one repo in parallel without
> conflicts; a race picks a winner; a Nest agent posts via the Bot API using a granted Supabase
> connection; the agent screenshots its own change before reporting done.

All five clauses run as one Playwright spec, `e2e/phase3.e2e.ts` (task 3.23), in one browser against
a real server: a mention ships a pull request, three agents share a repository through three
worktrees, a race is decided by the checks, a Nest agent answers from a granted connection, and
preflight refuses a push whose page logged an error.

## What shipped

| Area | Tasks |
|---|---|
| Bots as code and as files | 3.1 spec bots, 3.2 code bots in a sandbox, 3.3 grants and interactions |
| The world talking to Perch | 3.4 inbound webhooks, 3.5 schedules, 3.11 connector manifests v2, 3.25 the rest of the §5.5 seed list |
| Tools for bots | 3.6 MCP attach, 3.12 Perch as an MCP server, 3.24 runner-local stdio MCP servers |
| Agents in the room | 3.7 agent bots, 3.8 the hermes adapter, 3.9 the Nest, 3.10 orchestrators |
| The loop | 3.13 the board, 3.14 a worktree per task, 3.15 the merge queue, 3.16 race mode, 3.17 background sessions, 3.18 the testing loop, 3.19 agent presence, 3.20 the Pull Requests page |
| Seeing what happened | 3.21 inspector v2, 3.22 OTel traces and cost per work item |
| Work mode | 3.26 cycles with burndown and agent throughput, modules, saved views, five layouts, intake, relations, a document description |
| Proof | 3.23 the Phase 3 e2e |

## Decisions

ADR-0116 through ADR-0145 were added in Phase 3. The ones a reader should start with:

- **ADR-0122** a worktree per work item, so three agents in one repository are three directories.
- **ADR-0131** the merge queue lands one branch at a time and never rewrites somebody else's history.
- **ADR-0132** a race is decided by the checks, not by a vote.
- **ADR-0136** stopping an agent is a state change like any other, so the audit log hears about it.
- **ADR-0140** preflight drives the browser over DevTools, because that is the only way to know
  which console lines were errors.
- **ADR-0142** a runner-local MCP server has no credential, so it has no grant.
- **ADR-0143** three more webhook signature schemes, because that is what the seed list does.
- **ADR-0144** a burndown asks about the past, so an item records when it was finished.

## Verification (last run, this environment)

| Check | Result |
|---|---|
| `bun run check` (Biome, workflows, typecheck, `bun test`) | 789 pass, 0 fail |
| `bun run ct` (component tests + axe) | 55 passed, 1 skipped |
| `bun run e2e` (Playwright, desktop + mobile + the phase specs) | 83 passed |
| `bun run perf` | initial 177/180 KB, app 662/700 KB, 24 list surfaces, 0 unbounded |
| `bun run sdk:generate` | clean |
| `perch connectors check ./connectors` | 17 manifests, all usable |

## Spec deviations carried into Phase 4

- `model:` in a bot file names a model profile rather than a vendor id (task 3.1).
- What runs inside the code-bot sandbox is the bot-sdk's shape rather than the published SDK, which
  is HTTP and a WebSocket a sandbox with no host cannot do (task 3.2).
- `mcp_servers` rows for runner-local servers carry `project_id` beside `runner_id` (ADR-0142).
- `work_items` carries `completed_at`, which §6 does not list (ADR-0144).

## Phase 4

Written into [`../TASKS.md`](../TASKS.md) as 4.1–4.13 from §10's Phase 4 line (ADR-0146): the model
gateway at `/v1` with virtual keys, budgets and a usage dashboard, installers and package managers,
backups with a restore drill, RBAC and audit hardening, the agent CLIs in the runner image, a docs
site, templates and a demo workspace, security scanning and signed artifacts, the reliability bar,
an accessibility pass, Hub v1, and the stranger's two paths measured end to end.
