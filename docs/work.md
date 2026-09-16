# Work: a board the agents move

Every tracker has a Done column somebody drags a card into. This one has a **Running** column and
a **Needs you** column, and nobody drags anything into either: a session is running, or it stopped
to ask (spec §4 "Work (Plane)", §6, §7.1; task 3.13).

## The shape of an item

A work item belongs to a project and carries an identifier of `KEY-123` — the project's key and a
number counted per project, never reused (spec §7.8). Beyond the obvious fields it holds the links
that make it the one place to look: the thread it came out of, the session doing it, the pull
request that finished it.

| State | Means |
|---|---|
| **Backlog** | Somewhere to put it |
| **Queued** | Next |
| **Running** | A session is on it *right now* |
| **Needs you** | That session stopped to ask something |
| **In review** | The session finished; a person has not looked yet |
| **Done** | A person said so |
| **Cancelled** | Not happening |

## Where they come from

- **Typed in**, on the board in Work mode.
- **From a message.** Pass `thread_root_id` and the item remembers the conversation that started
  it, so the work and the talking stay one thing.
- **From an agent**, over `/mcp/perch` or the Bot API — `work.create` is one of the tools an
  outside agent has (see [the MCP gateway](./mcp-gateway.md)).

```
POST /api/workspaces/{ws}/projects/{p}/work-items  {title, type?, priority?, thread_root_id?}
GET  /api/workspaces/{ws}/projects/{p}/work-items?state&assignee&limit
GET|PATCH /api/work-items/{id}
POST /api/work-items/{id}/start-session  {engine?, prompt?}
```

## Handing one to an agent

**Hand to an agent** on a card opens a coding session on the item's project, titled `KEY-123` and
its title, and sends the item's own words as the first turn unless you say otherwise. From then on
the item follows the session:

| The session | The item |
|---|---|
| running | **Running** |
| asks a permission | **Needs you** |
| the answer arrives | **Running** |
| errors | **Needs you** |
| ends | **In review**, and the session link is cleared |

A session opened from a work item **settles when it is done** — it lets go of its runner rather
than holding one open for a conversation nobody is having, which is what moves the card. That is
different from a session you opened yourself, which waits for your next turn (ADR-0129).

An item that a person has already marked **Done** or **Cancelled** is never dragged back by
anything on the bus. A person's word is the last one.

## A directory of its own

Each item's session works in its **own git worktree**, on a branch named `perch/key-123`, made
from the project's default branch and sitting beside the project checkout at
`<project>.worktrees/perch-key-123` (spec §6 `coding_sessions.worktree`, §7.6 `worktree.*`; task
3.14).

This is the difference between two agents on one repository and two agents in one checkout. Three
items can run at once and none of them sees another's half-finished edits, because each is looking
at a different directory — the isolation is git's, not Perch's. And the branch each one is on is
already the branch a pull request wants.

Closing an item gives the directory back. The **branch stays**: a checkout is a place to work, not
the work, and a branch with commits on it is still there when somebody wants it. A project that is
not yet a repository — an empty one with no commit to branch from — has no worktree to give, and
the session works in the project directory instead rather than refusing to start.

## Landing what the agents wrote

Three agents finishing three branches at once is only half an answer — three branches written
against yesterday's `main` do not all apply to it. So they land through a **merge queue**, one at a
time, in the order they joined (spec §5.7; task 3.15).

```
POST /api/workspaces/{ws}/projects/{p}/merge-queue  {branch} | {work_item_id}
GET  /api/workspaces/{ws}/projects/{p}/merge-queue
```

For each branch, in turn:

1. **The project's checks**, run in the branch's own worktree — the first of `check`, `test`, `ci`
   or `verify` in `.perch/project.json`'s `run` map. A project that names none has no checks, and
   its branches land on git alone.
2. **Rebase onto the base**, so what landed before it is underneath it.
3. **Fast-forward the base onto it.** Both of those happen as one operation on the runner: two of
   them racing is what a queue exists to prevent.

A branch that will not rebase, or whose checks go red, **does not stop the queue**. It is marked
with git's own words or the tail of the command's output, its item goes to **Needs you**, and the
session that wrote it is sent a turn saying what broke. The next branch lands meanwhile. A queue
that stops at the first red branch is one that a single agent can hold hostage.

The thread gets one **queue card** per branch, rewritten in place as it moves. A branch that lands
takes its item to **In review** — not to Done, for the same reason a finished session does not.

The queue lands on the runner's checkout and does not push: getting that to a remote is what Open
PR is for. And a branch whose agent has fixed it goes back in the queue when somebody puts it
there; doing that automatically is the testing loop.

## The board

Work mode shows one column per state, urgent first and then oldest first, with a card per item.
Moving a card by hand is a select on the card rather than a drag, because a drag is a mouse and
the board has to work on a phone. Columns scroll on their own and the board asks for at most 200
items: past that, the answer is a filter rather than more cards.

The board is live. It subscribes to the workspace topic and refetches on any `work_item.*` event,
so a card moves under you while an agent works.

## What a bot hears

A bot installed in the workspace gets `work_item.updated` over the Bot API — what moved, not the
whole item:

```json
{
  "type": "work_item.updated",
  "payload": {
    "work_item_id": "…",
    "identifier": "NEST-12",
    "title": "Fix the login redirect",
    "state": "in_review",
    "changes": ["state"],
    "assignee_type": "bot",
    "assignee_id": "…"
  }
}
```

A bot that cares reads the item; a bot that does not should not be handed it.

## Roles

| Action | owner | admin | member |
|---|---|---|---|
| See a board | ✅ | ✅ | ✅ |
| Add, move, assign, close | ✅ | ✅ | ✅ |
| Hand an item to an agent | ✅ | ✅ | ✅ |

A board is what a team does together, so every member writes to it. Somebody who is not in the
workspace gets a `404` rather than a `403`: they do not learn the item is there either.

## Not here yet

Cycles and modules have their tables and their columns on an item, and nothing built on them yet.
Saved views, the other four layouts (list, calendar, timeline, spreadsheet), the Intake triage
queue, sub-items and relations, and a Tiptap description are §4's and arrive with their own tasks.

