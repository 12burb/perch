# Git: commit, branch, push, open a PR

The Git panel is the drawer's second tab, beside the terminal (**⌘J**, then Git). It is deliberately
small: what changed, what to include, a message, and the two buttons that get it somewhere else
(spec §4, §5.1; task 1.20).

## What changed

Every file git reports as changed, with what kind of change it is. Tick the ones this commit is
about; tick nothing and the commit takes everything. That is the whole of "staging" here — Perch
does not keep an index of its own, it passes the paths to `git commit`, so what you see is what
lands.

## The message

Write it, or press **Write it for me** and the project's agent writes it from the diff: a
conventional-commit subject and, when the change needs one, a short body. It runs on the same quiet
lane as ⌘K — no session pane, no permission prompts, no transcript to read later — and it costs
whatever the project's brain costs for a few hundred tokens.

The draft lands in the box, where it is yours to edit. Nothing is committed until you say so.

## Branching

The picker switches branches; the box beside it makes one. Both run in the project's own checkout on
its runner, so a session working there sees the same branch you do.

## Push, and Open PR

Both need a **connection** (Workspace settings → Connections), and both borrow its credential for
exactly one call: Perch mints a token, hands it to git or to the provider, and forgets it
(AGENTS.md §1.6, [connections](./connections.md)). Push sends the current branch; Open PR pushes and
then asks the provider to open the pull request, answering with its number and URL.

Without a connection, Push still works for a remote that needs no credential, and Open PR is
disabled with a line saying why.

## The API

Everything the panel does is a route, so a script can do it too:

| | |
|---|---|
| `GET .../git/status` | branch, tracking, ahead/behind, and the changed files |
| `GET .../git/diff?ref=&to=` | the working tree, or one ref against another |
| `POST .../git/commit` | `{message, paths?}` — the commit, as you |
| `POST .../git/message` | `{paths?}` — a drafted message |
| `GET/POST .../git/branches` | list, switch, create |
| `POST .../git/push` | `{branch?, connection_id?}` |
| `POST .../pull-request` | `{connection_id, title, body?, head?, base?}` |

## Not here yet

The Pull Requests page with inline comments and "ask the agent to address review" is Phase 3;
per-turn diffs and checkpoints already live in the session pane ([sessions](./sessions.md)).
