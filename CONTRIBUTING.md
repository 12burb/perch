# Contributing to Perch

Thanks for helping build the room. This document is the short version; the binding rules for anyone
(human or agent) writing code here are in [`AGENTS.md`](AGENTS.md) and the specification in
[`docs/spec/PERCH-SPEC.md`](docs/spec/PERCH-SPEC.md).

## Developer Certificate of Origin (DCO), no CLA

Perch uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/). There is no
Contributor License Agreement and there never will be one that enables relicensing (see
[`PLEDGE.md`](PLEDGE.md)).

Every commit must carry a `Signed-off-by:` line with your real name and email, which certifies the DCO:

```sh
git commit -s -m "feat(chat): add thread facts"
```

CI checks every commit on a pull request for the sign-off. Fix a missing sign-off with
`git commit --amend -s` (or `git rebase --signoff` for several commits) and force-push your own branch.

## Licenses

AGPL-3.0-only for `apps/*` and every package not listed here; MIT for `packages/bot-sdk`, `packages/ui`,
`packages/events`, `packages/api-client`, `connectors/`, and `templates/`. Your contribution is licensed
under the license of the directory it lands in.

## How work is organised

- `TASKS.md` is the queue. Take the first unchecked task whose prerequisites are checked; one task per branch
  (`task/<id>-<slug>`), one branch per PR. Never batch tasks.
- Big changes — licensing, the runner protocol (spec §7.6), the Bot API (§7.3), the policy schema, the pledge —
  go through an RFC in `docs/rfcs/` before code (see [`GOVERNANCE.md`](GOVERNANCE.md)).
- Any choice the spec does not make is an ADR in [`DECISIONS.md`](DECISIONS.md). Any deviation from a spec
  contract is an ADR plus a "Spec deviations" note in the PR.

## Setting up

```sh
bun install --frozen-lockfile
bun run check      # Biome + typecheck + bun test
bun run dev        # api + web + in-process runner against PGlite
bun run e2e        # Playwright
```

Bun 1.3.11 (`packageManager` in `package.json`). Node is only needed for tools that run under it in CI.

## Definition of done

Code + tests + changeset (`bun run changeset`) + docs updated + ADR for any choice not in the spec +
`bun run check` green + the relevant Playwright spec green + the task's acceptance criterion demonstrated in the
PR description. Never skip, weaken, or disable a test to get green.

## Pull requests

- Conventional commits (`feat(scope): …`, `fix(scope): …`, `docs: …`, `chore: …`), DCO signed-off.
- Fill in `.github/PULL_REQUEST_TEMPLATE.md` completely: what and why, spec sections, acceptance evidence,
  390 px and 1440 px screenshots for UI, spec deviations, ADRs.
- Keep PRs under roughly 600 changed lines except scaffolds.
- Every user-facing string goes through `t("key")`; every component has ARIA roles and labels; every flow
  works at a 390 px viewport; every long list is virtualized.
- Security invariants (spec §1.6) are non-negotiable, in tests too: no token, key, or subscription
  credential reaches an engine, a bot, a model context, a log line, or the client.

## Dependencies

Never guess a package name or version. Resolve from the official docs, pin the exact version, and record
non-obvious picks in `docs/dependencies.md` and `DECISIONS.md`. Renovate opens weekly update PRs.

## Reporting

- Bugs and features: GitHub issues (templates provided).
- Security: [`SECURITY.md`](SECURITY.md) — private reports through GitHub Security Advisories.
- Conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
