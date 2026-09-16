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

## All four at once (task 3.7)

An agent bot has nobody to press four buttons for it, so when its session finishes the same four
steps run in one go: a branch of its own, the secret scan, the commit, the push, and the pull
request. The gates are the same gates — a change with something that looks like a credential in it
is not committed, and a push is checked against the workspace's policy — and each step that cannot
happen stops there and says so on the card rather than being skipped quietly.

## The Pull Requests page (task 3.20)

The drawer's **Pull requests** tab is the connection's, not Perch's: it reads them live, because
Perch keeps no copy of a pull request and a copy would be a second answer that goes stale the moment
somebody comments in the provider's own UI. Pick a connection and it lists what is open; open one
and you get the three things a reviewer's decision is actually made of.

```
GET  /api/workspaces/{ws}/projects/{p}/pull-requests?connection_id=…
GET  /api/workspaces/{ws}/projects/{p}/pull-requests/{number}?connection_id=…
POST /api/workspaces/{ws}/projects/{p}/pull-requests/{number}/reviews  {verdict, body?}
POST /api/workspaces/{ws}/projects/{p}/pull-requests/{number}/address  {engine?}
```

| | |
|---|---|
| **Inline comments** | each with the file and the line it was left on, which is the whole difference between a review and a chat |
| **Reviews** | who has approved and who has asked for changes |
| **Checks** | on the head commit, because a pull request whose head moved has different checks from the one you were reading |

**Approve**, **Request changes** and **Comment** go straight back to the provider on the
connection's own delegated token. Asking for changes without saying why is a `422`: a request for
changes that does not say what to change is not a request.

### Ask the agent to address it

**Ask the agent to address it** opens a session on the pull request's own branch, in a worktree of
its own, and the first turn is the review — every comment with its file and line, plus what the
reviewers said, in the order they said it. It ends:

> Change the code to answer them. Do not reply in the pull request; the push is the answer.

That is the whole shape of it. Perch does not post a reply comment on the agent's behalf, because a
reply that is not a change is noise in somebody's inbox. The push is what answers a review.

The session is **unattended** (ADR-0133): nobody is sitting in front of it, so it settles when it is
done rather than holding a runner open.

A pull request whose branch this checkout has never seen is refused with a `422` naming the branch.
The alternative would be a session working on an empty branch cut from `main`, which looks like it
is working and is not.

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
