# Handoff

Where the last session left the repository, what bit it, and what is next. Written for whoever
picks Perch up next, person or agent, whatever the model. Read it after `AGENTS.md` and before
`TASKS.md`; end your own session by updating it. Keep it short: the reasoning lives in the ADRs.

## Where things stand (2026-09-21)

- **v0.3.0 is released** and every task in `TASKS.md` is checked. `main` was green on all nine CI
  checks when this file landed. Verify before trusting it:
  `curl -s https://api.github.com/repos/12burb/perch/commits/main/check-runs | jq '.check_runs[] | [.name, .conclusion]'`.
- **The code audit is done.** Twelve lenses, 88 distinct findings, every confirmed one fixed with a
  test that failed first: ADR-0160 (runner child environments), 0161 (OpenCode per environment),
  0162 (api tokens and membership), 0163 (runner call budgets and reconnects), 0164 (argv and
  filesystem discipline), 0165 (nothing left running, growing or waiting), 0166 (dependencies
  declared where used, boundaries checked), 0167 (session pane feed, capped lists, strings through
  the catalog), 0168 (one test process per workspace, verified image downloads, bounded wake
  memory, the committed gate).
- **Standing directions from the maintainer**, still in force: work lands on `main` directly
  (ADR-0065) with the full local gate green before every push; a red `main` is fixed forward before
  anything else; there are no paid plans and never will be, anyone connects their own models
  (ADR-0064); a question gets an answer in chat, not a document; the first-touch deliverable is one
  downloadable binary per platform.
- **Bun stays.** The maintainer asked whether to keep Bun; the recommendation was to stay, because
  the single cross-compiled binary is the deliverable and Bun is not a thin layer here (181 test
  files on `bun:test`, 147 source files on `Bun.*`, 91 `Bun.serve` sites). No ADR was written
  because nothing changed. Leaving Bun would be a spec change (spec §1.1, plan §10.1): an ADR first,
  then a multi-week rewrite, with Node 24 the safer target and the binary story the cost.

## How to work here

1. One batch per branch in its own worktree (`git worktree add ../perch-work -b <branch> main`,
   then `bun install --frozen-lockfile` there); `main` stays clean for hotfixes.
2. `bun run gate` runs everything CI runs, in CI's order, about 35 minutes on four cores. It
   outlives most tool timeouts, so run it detached and poll:
   `(setsid nohup bash scripts/gate.sh > /tmp/gate.log 2>&1 &)` then
   `grep -n '^===\|exit=' /tmp/gate.log`. Do not run other heavy suites while its e2e step runs;
   the timing-sensitive specs flake under load and cost a 30-minute rerun.
3. Green gate → `git -C ../perch merge --ff-only <branch> && git push -u origin main`, then watch
   CI. The reliability bar and the runner-image job take about ten minutes each.
4. CI diagnosis without a browser: the check runs at
   `https://api.github.com/repos/12burb/perch/commits/<sha>/check-runs`, each one's annotations
   at `/repos/12burb/perch/check-runs/<id>/annotations`, and the job log through the GitHub API
   (`actions/jobs/<id>/logs`). A push to `main` cancels the run in progress for the previous
   commit, so a "cancelled" job is not a failure.
5. Commits: conventional subject, DCO sign-off (`git commit -s`), a body with what, why, the spec
   sections, the acceptance evidence (test names, or a command and its output) and the ADRs added.
   A changeset for every user-visible change; an ADR in `DECISIONS.md` for every choice the spec
   does not make.

## What bit us, so it does not bite you

- A test that commits with plain `git` must pass `-c user.name=… -c user.email=…`: CI runners have
  no identity, and the test passes on every laptop.
- On Windows a killed child holds its working directory for a moment. Await the exit before
  removing anything (the ACP and MCP hosts now do), and remove temp trees through
  `apps/runner/test/helpers/tmp.ts` (`removeTree`), which retries and never fails the run.
- On Windows `process.env` spells it `Path`; look the key up case-insensitively, as
  `apps/runner/test/env.test.ts` does.
- Every process the runner starts gets its environment from `childEnv()` (ADR-0160). A new spawn
  site that inherits `process.env` fails `env.test.ts`, on purpose.
- `bun test` at the root used to run all 180 files in one process, and PGlite ran out of memory
  once, late in the run. `bun run test` is one process per workspace now (ADR-0168); a repository
  invariant fails if a test file sits outside a workspace the runner walks.
- git 2.43 (the sandbox's) has no `--end-of-options` on `checkout`; the runner validates branch
  names instead (ADR-0164).
- `pkill -f` with a pattern that also matches your own shell's command line kills your own shell.
  Find pids with `ps -eo pid,args` and kill those.
- The perf audit's long-list net only sees a file with its own scroll container. A list rendered
  into the page's scroller has to be capped by hand and added to `LIST_SURFACES` in
  `scripts/perf-budget.ts` (ADR-0167).
- `bun install --frozen-lockfile` does not compare workspace versions in `bun.lock`. After
  `changeset version`, run `bun install` and commit the lock, or the next audit finds it stale.
- Playwright in a sandbox: `PLAYWRIGHT_CHROMIUM_EXECUTABLE` names the browser; the gate script
  finds the newest one under `/opt/pw-browsers` when the variable is unset.
- The Preview tab reloaded its page every four seconds (ADR-0169): each ports poll minted a fresh
  member ticket, the ticket was on the iframe's URL, and a new URL is a navigation. It showed
  only as the preview e2e spec failing under load; its trace (one document, a new HMR socket
  every four seconds, no `#app`) was the tell. The spec now asserts no navigation across two
  poll intervals. When an e2e spec fails in the gate and passes alone, read the trace before
  calling it a flake: `unzip` the zip under `test-results/`, and the `.network` file lists every
  request with its time.

## Open items, in order

1. **Signatures on the runner image's downloads.** Bun, Node and uv are fetched from their release
   pages and checked against the checksums published with the release (ADR-0168). That proves the
   transfer, not who cut the release. Bun and Node publish signed checksum files and uv publishes
   attestations; verifying those in `deploy/Dockerfile.runner` is the next step. The image builds
   in CI on every push ("The agent CLIs in the runner image"), so a wrong step shows within ten
   minutes.
2. **Unit-test memory.** Watch the check job. If PGlite runs out of memory again inside the api
   workspace's own process, split that run further (by directory) or close what its tests open.
3. **Renovate's regex managers** (`deploy/agents.json`, the Dockerfile's `BUN_VERSION`,
   `PLAYWRIGHT_VERSION`, `HERMES_VERSION`, and `apps/runner/src/hermes.ts`) have not seen a
   Renovate run yet. After the next Monday run, check the dependency dashboard; if Renovate rejects
   the config, the error names the key.
4. **Windows** is green on the laptop smoke and the PTY, and remains the least exercised platform.
   A Windows-only failure is fixed forward, never skipped or excused.
5. **Product.** `TASKS.md` is complete. The plan's "Later" row (`docs/spec/PERCH-PLAN.md` §8) holds
   the candidates: Perch Link (hosted OAuth broker), a Helm chart, SAML/SCIM, push and an offline
   PWA, voice notes to bots, a bot and connector marketplace, an LSP-rich editor, multi-node
   runners, Slack and Discord bridges, the `native-code` engine. Choose with the maintainer, then add
   the task to `TASKS.md` with prerequisites and an acceptance criterion before building; the
   workflow in `AGENTS.md` §2 takes it from there.

## Session log

- **2026-09-21.** The code audit landed (ADR-0160 to ADR-0168, eleven batches). `main` went red
  three times and was fixed forward each time: a test without a git identity, a Windows teardown
  race in the ACP test, and one PGlite out-of-memory in the single-process test run. The
  maintainer's Bun question was answered (stay). The last-mile batch (ADR-0168) and this file
  were written; its gate found the Preview tab's four-second reload (ADR-0169).
