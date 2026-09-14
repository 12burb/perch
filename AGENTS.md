# Perch — agent operating manual

You are building Perch: a self-hosted, open-source agentic workspace — IDE + team chat + bots + connections +
model gateway — in one TypeScript monorepo on Bun. The binding specification is `docs/spec/PERCH-SPEC.md`
(read it fully once per session). `docs/spec/PERCH-PLAN.md` is the extended plan behind it, and
`docs/spec/KICKOFF.md` holds the kickoff prompts. Keep these spec sections open while you work: §1 (ground
rules), §2 (stack), §4 (UI/UX shell), §6 (schema), §7 (contracts), §8 (env, deploy, CI), §9 (conventions,
DoD, spikes), §11 (tasks).

Every session starts by reading this file and `TASKS.md`, then resumes from the first unchecked task whose
prerequisites are checked. If a task is marked `[~]`, check whether its branch exists and resume it before
starting anything new.

## 1. Ground rules (never break these)

1. TypeScript end to end, runtime Bun. Bun workspaces + Turborepo, Biome, strict TS with
   `noUncheckedIndexedAccess`, Zod at every boundary. No other language in this repo; Python exists only as
   third-party agent runtimes inside the runner image. No `any`.
2. `TASKS.md` (spec §11) is the queue. Take the first unchecked task whose prerequisites are checked. One task
   per branch (`task/<id>-<slug>`), one branch per PR. Never batch tasks. Never start a task whose
   prerequisites are unmerged.
3. Resolve exact package names and versions from official docs before adding any dependency (task 0.3) and
   pin them. Never guess a package name. Nothing in the spec is a version pin. The resolved table lives in
   `docs/dependencies.md`.
4. Run every Phase 0 spike (spec §9.3) as its own PR; record each outcome in `DECISIONS.md` before building on
   it; if a spike fails, take the listed fallback.
5. Implement spec §7 contracts exactly: paths, envelopes, event names, error shapes. Any deviation = an ADR in
   `DECISIONS.md` + a "Spec deviations" note in the PR.
6. Security invariants: no connection token, API key, or subscription credential ever reaches an engine, a
   bot, a model context, a log line, or the client — vault in, gateway out. `apps/api` never mounts the Docker
   socket; only the supervisor does. Runners speak only the §7.6 protocol; a local runner refuses requests for
   users other than its owner unless a grant is attached. Personal subscription credentials are user-scoped
   and never proxied; anything shared runs on API keys or local models. Perch never forwards a caller's bearer
   token upstream; each connection uses its own delegated token.
7. Every screen follows the §4 shell; every long list is virtualized; every flow works at a 390 px viewport;
   every component has ARIA roles and labels.
8. Definition of done: code + tests + changeset + docs updated + ADR for any choice not in the spec +
   `bun run check` green + the relevant Playwright spec green + the task's acceptance criterion demonstrated
   in the PR description. Never skip, weaken, or disable a test to get green.
9. Do not ask the human questions. Choose the sane default, record it in `DECISIONS.md`, keep going. If the
   spec is wrong or impossible, build the closest correct thing and write the ADR.
10. Do not add infrastructure beyond spec §3.1 (no Redis, queues, object stores, extra services) without an
    ADR.

## 2. Workflow for every task

1. `git checkout -b task/<id>-<slug>` from `main`.
2. Mark the task `[~]` in `TASKS.md` with the branch name (commit this first).
3. Re-read the spec sections the task names. Write the acceptance test first when the criterion is testable
   (unit or Playwright), then implement.
4. Run `bun run check` (Biome, typecheck, `bun test`) and the relevant Playwright spec. Both green.
5. Update the docs the task touches (`docs/`, package READMEs, `.env.example`, OpenAPI).
6. Add a changeset (`bun run changeset`) describing the user-visible change.
7. Commit with a conventional commit message and DCO sign-off (`git commit -s`).
8. Open the PR with the template: what, why, spec sections, acceptance evidence (test names or a command and
   its output), screenshots at 390 px and 1440 px for UI, spec deviations, ADRs added.
9. In the same PR mark the task `[x]` with the PR link.
10. Move to the next task. Never batch several tasks into one PR.

## 3. Commands

| Command | Does |
|---|---|
| `bun install --frozen-lockfile` | install |
| `bun run check` | Biome + typecheck + `bun test` across the workspace |
| `bun run lint` / `bun run format` | Biome lint / Biome format (write) |
| `bun run typecheck` | `tsc --noEmit` in every workspace |
| `bun run test` | `bun test` across the workspace (PGlite in memory for db tests) |
| `bun run e2e` | Playwright against the laptop-mode server |
| `bun run dev` | api + web + in-process runner in watch mode against PGlite |
| `bun run build` | production builds for every app |
| `bun run db:generate` / `bun run db:migrate` | Drizzle migrations (generate + embed / run) |
| `bun run perf` | payload and bundle budgets |
| `bun run changeset` | add a changeset |

## 4. Repo map

`apps/web` (React PWA), `apps/api` (Hono on Bun; also the supervisor entrypoint), `apps/runner` (PTY, engines,
fs, git, ports, preview tunnel), `apps/cli` (`perch` binary), `packages/*` (db, events, bus, jobs, vault,
gateway, engines, connect, bots, policy, preview, inspector, bot-sdk, ui, api-client), `connectors/`
(manifests), `templates/`, `deploy/`, `docs/`, `spikes/` (Phase 0 spikes, kept runnable), `scripts/`.

## 5. Conventions (spec §9.1, condensed)

- Handler (Hono + Zod) → service (pure functions over `Db` and `Bus`) → repository (Drizzle). No SQL in
  handlers, no HTTP in services.
- Every state change emits a bus event from `packages/events`; WS fan-out, inbox, webhooks, and audit
  subscribe. Features never write the audit log directly.
- Typed `PerchError(code, message, details, status)`; wire shape in spec §7.8; never leak stacks or secrets.
- `authorize(ctx, action, resource)` from `packages/policy` in every handler; workspace scoping enforced in
  repositories.
- Query parameters are bound through column encoders: drizzle operators or `sql.param(value, column)`;
  never a bare `Date` (or other typed value) inside a `` sql`…` `` template (ADR-0061).
- Migrations generated with `drizzle-kit`, committed, run on boot under an advisory lock, never edited once
  shipped.
- pino, one line per request with `request_id`, `workspace_id`, `user_id`; secrets redacted by key list.
- Feature flags via `flags.isOn(name)`; default off; removed within two releases.
- Every user-facing string through `t("key")`, even with only `en`.
- Conventional commits; DCO sign-off; PR template filled in completely. Keep PRs under ~600 changed lines
  except scaffolds (0.1, 0.5, 0.11).

## 6. Definition of done

Code + tests + changeset + docs updated + ADR for any choice not in the spec + `bun run check` green + the
relevant Playwright spec green + the task's acceptance criterion demonstrated in the PR description. Nothing
else counts.

## 7. Prohibited

Guessing package names or versions. Editing a shipped migration. `any`. Committing secrets or `.env`.
Skipping a spike. Adding infra without an ADR. Marking a task done without evidence. Asking the human
questions that the spec or an ADR could answer.
