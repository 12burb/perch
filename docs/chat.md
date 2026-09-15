# Chat: channels

Spec §5.2, §7.1. A workspace is a place to talk: the rooms, and what is said in them. Reactions,
files and unfurls arrive with task 2.3.

## The five kinds of room

| Type | Named by | Who sees it |
|---|---|---|
| `public` | a name (`#release-notes`) | everybody in the workspace |
| `private` | a name | the people in it |
| `dm` | who is in it | the two people in it |
| `group` | who is in it | the people in it |
| `item` | the work item it hangs off | the people in it |

A name is what people type after a `#`: lower case, digits and dashes. Perch normalizes what you
type — `Release Notes` becomes `release-notes` — and refuses a second channel with the same name in
the same workspace, whatever case it was typed in. A DM, a group and an item thread have no name at
all; the client draws them from who or what is in them.

## Getting in, and out

A public channel is open: any member joins it from Home, and nobody has to be asked. Anything else
is opened from the inside — somebody already in it adds you — which is also how a private channel
fills up. Leaving is always yours to do, and taking somebody else out needs you to be in the channel
with them.

Nobody joins an archived channel.

## Archiving

Archiving takes a channel away from everybody in it, so it belongs to the people who answer for the
workspace: owners and admins (`channels.archive`). Everything else about a channel — starting one,
renaming it, setting its topic, adding people — is any member's to do (ADR-0090). An archived
channel keeps its messages and its members; it drops out of the sidebar and refuses new arrivals,
and an admin can put it back.

## Unread

The sidebar's weight is what is waiting for you: channels sort by unread first and then by name, and
a channel with unread messages shows the count. What counts is every message that arrived after the
one you last read, minus your own and anything deleted. The read mark is a message id, and ids are
UUIDv7 (ADR-0025), so "newer than the mark" is an id comparison rather than a timestamp one — two
messages written in the same instant cannot confuse it.

## Routes

| Route | Does |
|---|---|
| `GET /api/workspaces/{ws}/channels` | every channel you can see, with `member`, `unread` and `member_count` |
| `POST /api/workspaces/{ws}/channels` | start one: `{type, name?, topic?, project_id?, members?}` |
| `GET /api/workspaces/{ws}/channels/{channel}` | one channel |
| `PATCH /api/workspaces/{ws}/channels/{channel}` | `{name?, topic?, archived?}` |
| `GET /api/workspaces/{ws}/channels/{channel}/members` | who is in it |
| `POST /api/workspaces/{ws}/channels/{channel}/members` | join, or `{user_id}` to add somebody |
| `DELETE /api/workspaces/{ws}/channels/{channel}/members/{user}` | leave, or take somebody out |

A channel you may not see answers 404 rather than 403: a private channel's name is private too.

Every change publishes a bus event — `channel.created`, `channel.updated` (with `changes`, which is
`["members"]` for a join or a leave), `channel.archived` — which is what fans out over the
WebSocket, writes the audit line, and makes the sidebar update itself in every open tab.

## Messages

A message is **blocks**, never a string (spec §6 `messages.blocks`). The composer sends `text` and
the api makes the one text block it is; a bot sends blocks itself, which is how a diff card, a
session card or a button arrives in the same column as "morning". The blocks a client may send are
the discriminated union in `packages/db/src/shapes`; anything else is refused before it is stored.

| Route | Does |
|---|---|
| `GET …/channels/{c}/messages?before&after&limit` | a page, oldest first |
| `POST …/channels/{c}/messages` | `{text \| blocks, thread_root_id?}` |
| `GET …/messages/{m}/thread` | a thread: its root and everything hanging off it |
| `PATCH …/messages/{m}` | `{text \| blocks}` to edit, `{pinned}`, `{bookmarked}` |
| `DELETE …/messages/{m}` | take it down |
| `GET …/messages/{m}/edits` | what it said before |
| `GET …/channels/{c}/pins` · `GET …/bookmarks` | the channel's pins; your own Later list |
| `POST …/channels/{c}/read` | `{message_id}`: where you have read up to |

Paging is by message id. Ids are UUIDv7 (ADR-0025), so `before` is "older than this" and `after` is
"newer than this" with no cursor of its own, and two messages written in the same instant cannot
make a page slip.

### Threads

A reply carries `thread_root_id`. Threads are one deep: replying to a reply joins the same thread
rather than starting another. The root keeps `reply_count`, which is what the channel shows beside
it, and replies stay out of the channel's flow — they are read in the thread.

### Editing and deleting

Editing is the author's own; each edit files the blocks it replaced in `message_edits`, so
"(edited)" can be opened rather than merely believed. Deleting is the author's, or an admin's when
something has to go (`messages.moderate`); the row stays, empty, so a thread keeps its shape and a
reply count stays honest.

### Pins, bookmarks, and what is unread

A **pin** belongs to the channel: everybody sees it, anybody in the channel sets it. A **bookmark**
is one person's own Later list and is published to nobody.

The unread count is every message in the channel's flow that arrived after the one you last read —
not your own, not deleted ones, and **not replies in a thread**, because a reply is not in the flow
and reading the channel could never clear it. Reading is the client saying where it has got to:
`POST …/read` with the last message it has shown you.

### Mentions

A mention is `<@handle>` for a person and `<#name>` for a channel — the shape §7.3 already promises
bots ("a bot posting `<@dawn>` triggers exactly the same mention path as a human"). The composer
writes the token when somebody picks from its list, and the client renders it back as a name; the
api resolves the handles, and every mentioned member of that channel gets one more on their mention
count. Typing `@` or `#` at a word boundary opens the list, the arrows move through it, Enter or Tab
takes the highlighted one, and Esc closes it — the caret never leaves the composer.
