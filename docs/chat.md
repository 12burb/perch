# Chat: channels

Spec §5.2, §7.1. A workspace is a place to talk. This page is the room itself — who can see it, who
is in it, and what happens to it when it has served its purpose. Messages, threads and reactions
arrive with task 2.2.

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
