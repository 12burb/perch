# The launch bar

Phase 4's exit criterion is a promise to strangers: **`docker compose up` and `curl | sh` both work
for people who aren't you, and the time from arriving to your first agent's pull request is under
ten minutes.** A promise like that is worth nothing unless something measures it on every push, so
this is the table it is measured against.

```
$ bun run launch
```

| Leg | Budget | Measured by |
|---|---|---|
| `compose-up` — `docker compose up` → the wizard answers and an admin is signed in | 10 min | the compose smoke in CI, timed from the `up` |
| `curl-sh` — `curl \| sh` → a `perch` binary on the path, checksum checked | 5 min | `apps/cli/test/install.test.ts`, against a stand-in release server |
| `laptop-boot` — `perch dev` → an instance serving on PGlite with a runner | 2 min | `apps/cli/test/laptop.test.ts` |
| `first-agent-pr` — a stranger arrives → an agent's pull request is open | **10 min** | `e2e/phase4.e2e.ts`, at a 390 px viewport |

The budgets live in one file, `scripts/launch-bar.ts`, and **each leg asserts its own budget where
it runs** — so a regression fails the job that caused it, with the number in the log, rather than
turning up in a report at the end. `bun run launch` with no arguments prints the bar and where each
leg is proved; with `--from <file>` it reads measurements and exits non-zero on anything over.

Ten minutes is the spec's number, and it belongs to the whole loop rather than to one leg: a
stranger who spends nine minutes pulling images has not arrived in ten. The two ways in are
budgeted inside it, generously, because they run on whatever CI runner and whatever network the day
gives them.

## What the ten minutes contains

`e2e/phase4.e2e.ts` starts the clock at `/sign-up` on an instance somebody else has already stood
up, and stops it when the pull request is open. In between, on a phone:

1. Sign up, and make the first workspace from the welcome screen.
2. Find something in the [Hub](hub.md) and install it.
3. Connect the service the work lives on, by pasting a token.
4. Clone a repository through that connection.
5. Start a session, ask for a change, and allow the write when the agent asks.
6. Read the diff.
7. Branch, commit, push, and open the pull request.

No shortcuts: every step goes through the screen a person would use, and axe sweeps the pages on
the way past. Nothing leaves the machine — `scripts/e2e-server.ts` stands up the GitHub it clones
from and opens the pull request on, and the agent that makes the change.

## The two ways in

Both paths are documented in [`install.md`](install.md) and [`deploy.md`](deploy.md); what belongs
here is that both are **run**, on every push:

- **`docker compose up`** — the compose smoke builds the images from the commit, runs `perch init`,
  brings the stack up, drives the setup wizard over HTTP, signs in, reads `/api/me` and the
  workspace, takes a backup and restores it into an empty database.
- **`curl | sh`** — `install.sh` runs against a stand-in release server: it resolves the newest
  release, downloads the asset, checks it against `SHA256SUMS`, refuses a tampered one, and puts a
  runnable binary on the path. Then the laptop smoke boots `perch dev` on macOS, Linux and Windows.

## When a leg goes over

The failure names the leg, the number and the budget. Start with what the job did rather than with
the bar: a leg goes over because something got slower, and the bar is the messenger. Raising a
budget is a decision to write down — it means telling strangers to wait longer — so it belongs in
an ADR, not in a commit that is really about something else.
