# Chat: channels

Spec §5.2, §7.1. A workspace is a place to talk: the rooms, and what is said in them — reactions,
files, unfurls, search, and the blocks a bot asks a question with.

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
| `POST /api/workspaces/{ws}/channels` | start one: `{type, name?, topic?, project_id?, members?}`; a `project_id` or member outside this workspace is 404 |
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
the api makes the one text block it is; a bot sends blocks itself, which is how a code block, a
tool card or a button arrives in the same column as "morning". The blocks a client may send are
the discriminated union in `packages/db/src/shapes`; anything else is refused before it is stored.

The cards Perch posts about its own work — `session_card`, `diff_card`, `race_card`,
`deploy_card`, `queue_card`, `background_card`, `preflight_card`, `plan_card`, `webhook_card` —
are in the same union but are **not** a client's to send: the transcript draws them as records
Perch vouches for, and some carry an action (a race's Pick) or a link into the app. They are written
only by the service that did the work, and `POST`/`PATCH` a message (and the Bot API's
`chat.postMessage`/`chat.update`) answer 422 for any of them (ADR-0174). The transcript still takes
nothing on a card's word: a race card reads its race back from `GET /api/races/{id}` and offers Pick
only on a system-posted card once the api has answered, and a card's "Open" is drawn only for a
path on this origin.

| Route | Does |
|---|---|
| `GET …/channels/{c}/messages?before&after&limit` | a page, oldest first |
| `POST …/channels/{c}/messages` | `{text \| blocks, thread_root_id?}` |
| `GET …/messages/{m}/thread` | a thread: its root and everything hanging off it |
| `PATCH …/messages/{m}` | `{text \| blocks}` to edit, `{pinned}`, `{bookmarked}` |
| `DELETE …/messages/{m}` | take it down |
| `GET …/messages/{m}/edits` | what it said before |
| `GET …/channels/{c}/pins` · `GET …/bookmarks?before&limit` | the channel's pins; your own Later list in this workspace |
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
"(edited)" can be opened rather than merely believed. The version filed is the one in the row when
the edit lands (the row is locked for the change), so two quick edits from two tabs keep every
version. Deleting is the author's, or an admin's when something has to go (`messages.moderate`);
the row stays, empty, so a thread keeps its shape and a reply count stays honest. A delete takes the
message's history with it: `…/edits` of a deleted message is empty, and a rewrite still on its way
(a bot's streaming reply, a card moving) finds nothing to write into. Two deletes at once are one:
the second changes nothing, takes nothing off the thread's count, and publishes nothing (ADR-0174).

An **archived** channel is a record. Nobody edits a message in it, and only an admin
(`messages.moderate`) takes one down; everybody else is answered 409.

### Pins, bookmarks, and what is unread

A **pin** belongs to the channel: everybody sees it, anybody in the channel sets it. A **bookmark**
is one person's own Later list and is published to nobody. The list is per workspace and is read
against the channels you can open now: a bookmark outlives leaving a channel, but the message it
points at stops being listed when you can no longer read it there. It is a page, newest save first
(`limit` up to 200, default 50; `before=<message id>` for the next one).

The unread count is every message in the channel's flow that arrived after the one you last read —
not your own, not deleted ones, and **not replies in a thread**, because a reply is not in the flow
and reading the channel could never clear it. Reading is the client saying where it has got to:
`POST …/read` with the last message it has shown you.

### Mentions

A mention is `<@handle>` for a person and `<#name>` for a channel — the shape §7.3 already promises
bots ("a bot posting `<@dawn>` triggers exactly the same mention path as a human"). The composer
writes the token when somebody picks from its list, and the client renders it back as a name; the
api resolves the handles, and every mentioned member of that channel gets one more on their mention
count. Editing a message counts only the mentions the edit adds: fixing a typo in a line that names
somebody does not name them again. Typing `@` or `#` at a word boundary opens the list, the arrows move through it, Enter or Tab
takes the highlighted one, and Esc closes it — the caret never leaves the composer.


### Reactions

An emoji on a message is the channel's, like a pin: everybody in the room sees it, and anybody in
the room may add one. Your own is a toggle — the pill under the message says how many put it there
and whether one of them is you, and clicking it adds or takes away yours alone. Reacting twice with
the same emoji is the reaction you already had: no second row, and nobody is told again. The
`reaction.added` and `reaction.removed` events travel on the workspace topic, so a pill appears
under everybody's copy of the message at once. Emoji only: a handful of code points, no whitespace
and nothing invisible.

`POST /api/workspaces/{ws}/messages/{m}/reactions {emoji}` and
`DELETE …/reactions/{emoji}` both answer with the message, pills and all. The emoji in the `DELETE`
path is percent-encoded once, as any path segment is, and decoded once by the router.

### Interactive blocks

Five of the block kinds are a question rather than a statement: `button`, `select`, `form`,
`approve_deny`, and `progress`, which is the one nobody answers — the bot moves it, everybody else
reads it. The other four carry an `id`, which is how an answer says which of them it is answering,
and an `action`, which is the name the bot gave what pressing it means.

```
POST /api/workspaces/{ws}/messages/{m}/interactions  {block_id, values?}
```

`values` is what was chosen or typed: `{value}` for a button or a select, `{decision}` —
`approved` or `denied` — for approve_deny, and one entry per filled-in field for a form. The api
checks the answer against the block that asked: a select takes one of its own options, a form takes
its required fields, and a decision is one of the two words. Answering is writing in the channel, so
it needs the same membership saying something does.

Two things then happen, and both matter.

**The block is answered in place.** The answer is written into the block itself (`state`: who, when,
and the values), so the message carries its own outcome: the person who opens the channel tomorrow
reads the same thing as the person who pressed the button, with no second request and nothing to
replay. The message gains no "(edited)" mark and files nothing in `message_edits` — recording an
answer is not a rewrite (ADR-0095). `message.updated` goes out on the bus, so every open tab redraws
it at once.

**The payload goes to the bot that owns the block**, in the shape §7.3 names:

```json
{ "type": "interaction.received",
  "payload": { "workspace_id": "…", "channel_id": "…", "message_id": "…",
               "block_id": "deploy", "action": "deploy", "block_type": "approve_deny",
               "values": { "decision": "approved" },
               "user": { "type": "user", "id": "…", "name": "Wren" },
               "at": "2026-09-15T10:31:00.000Z" } }
```

This is a **Bot API** event, not a bus event: the bus catalog is exactly §7.7's list, and the shape
above is the outward-facing one, Slack-shaped on purpose. It is handed over by `@perch/bots`, which
is where the Bot API's socket subscribes; it goes to the bot that posted the block and to nobody else
(a block a person posted belongs to no bot). Spec §7.3's HMAC-signed webhook is not built: the socket
is the one transport (ADR-0176). A bot is told what happened and by whom — never a token, a key, or
anything it could reach something else with.

A question is answered once. Whoever gets there first is who it says; a second press is refused
(409) and the block still reads as the first answer. "First" is decided against the row, which is
locked while the answer is written: two presses at the same moment are one answer, one 409 and one
`interaction.received`, and answers to two different blocks of one card are both kept (ADR-0174). The client draws all five kinds through
`BlockRenderer` (`@perch/ui/blocks`), which also draws them answered — the chosen option by its
label, the decision as a badge, a form's fields as what they were filled in with — and offers no
controls at all to somebody who is only reading the channel.

## Files

An upload goes to `POST /api/workspaces/{ws}/files` as a plain multipart form and lands on the
instance's own volume (`PERCH_FILES_DIR`) — there is no object store to run (spec §3.1). The answer
is metadata; the bytes are a second request, so a transcript decides for itself what it draws and
what it only names. A message points at a file with a `file` block, and the api hands the file's
name, type and size back beside the message so the client can draw it without asking again. A file
block may only name a file of its own workspace.

What comes back is deliberately dull (ADR-0093):

- `GET /api/files/{id}` is **always a download**: `application/octet-stream`, an attachment
  disposition, `nosniff`, and a sandbox CSP. Nothing an upload says about itself makes a browser run
  it on Perch's origin.
- `GET /api/files/{id}/preview` serves the file as itself for the image types a browser can draw
  without running anything — PNG, JPEG, GIF, WebP, AVIF. SVG is not one of them: it carries script,
  so it has no preview and downloads like everything else.

Uploads are capped at 25 MB, and previews are the original bytes rather than a thumbnail: nothing is
re-encoded yet, and the transcript constrains what it draws.

Reading a file is reading the message it was said in: your own uploads always, and anybody else's
only through a message in a channel you can see (ADR-0094). A file attached in a private channel is
as private as the channel — asking for it by id answers 404, the same way the channel does. A file
nobody has posted yet is its uploader's alone.

## Unfurls

Every Perch object has an identifier (spec §1), and pasting one in a message turns it into a card:
`session:8f2c`, `project:NEST`, `channel:general`, `message:<id>`, or the same thing longhand as a
`perch://` link. The client collects the identifiers on screen and asks
`POST /api/workspaces/{ws}/unfurl` once for the page; the api answers with a card for each — a
title, a line under it, and where it lives — and with nothing at all for anything the caller could
not have opened anyway. A private channel unfurls for the people in it and for nobody else, and an
identifier from another workspace is not a card. A reference is looked up as an id only when it is
shaped like a uuid; anything else is a name, a key or a session-id prefix, so a 36-character name is
found by its name and a 36-character token that names nothing is simply not a card.

Work items (`NEST-123`) and pull requests (`pr:42`) unfurl when they exist: Phase 3 and task 2.14.

## Web push

A mention reaches a phone (task 2.3). The browser registers Perch's service worker, Settings →
Profile → Notifications asks for permission once, and the subscription — an endpoint at whatever
push service that browser uses, plus the two keys — is stored against the person, one row per
device.

When somebody is named in a channel they are in, the push subscriber hears `message.created` on the
bus and sends each of their devices one notification: who said it, the first line of what they said,
and where to land. It is encrypted to that device's keys (RFC 8291, `aes128gcm`) and identified with
a VAPID assertion (RFC 8292), so the push service carries ciphertext and learns nothing — not who it
is for, not what it says. A push service that answers 404 or 410 has retired that device, and Perch
stops using it.

A push endpoint is somewhere the api posts to from its own network, so it has to look like what a
browser's push service is (ADR-0173): an `https` URL on a public address. Anything else — plain
`http`, loopback, a private range, the cloud metadata address — is refused with a `422` when the
device subscribes, and again when a message goes out (a subscription that no longer passes is
retired). Laptop mode, or `PERCH_OUTBOUND_ALLOW_PRIVATE=on`, relaxes both.

A notification never holds up the message it is about. The push subscriber works detached from the
`message.created` event, a push service gets ten seconds to take each message, and a person's
devices are told at the same time rather than one after another. At shutdown, pushes still waiting
on a push service are abandoned.

The instance's VAPID key pair is made on first use and kept in `instance_settings`, the private half
sealed by the vault: a laptop-mode Perch notifies people with no configuration at all.

While the tab is open the worker passes the message to the page instead, and it shows as a live
region at the bottom of the shell with a link to follow.

Signing out releases the device: Perch deletes its subscription row while the session still works,
then the browser unsubscribes, so the person who signed out gets no more notifications there and
whoever signs in next sees none of theirs. Turning push on again after the next sign-in makes a new
subscription for that person.


## Search

One box, three kinds of result: `GET /api/workspaces/{ws}/search?q&type&channel&from&limit`, the path
§7.1 names. Messages are matched by Postgres full text — `messages.text_search` is a generated
tsvector with a GIN index, so nothing is indexed twice and there is no search service to run — files
by name, and code by the codebase index of every project in the workspace
([`repo-intelligence.md`](repo-intelligence.md)).

What you can type is what `websearch_to_tsquery` takes: bare words, `"a quoted phrase"`, `or`, and a
leading `-` to leave a word out. English stemming means "migration" finds "migrations". Results are
ranked by `ts_rank_cd` and, where two match equally well, the newer one is first.

Filters: `type` (`all`, `messages`, `files`, `code`), `channel` (one channel — one you can see;
naming any other answers 404, exactly as the channel itself does), and `from` (one person).
Everything is scoped to what you could have read anyway: the public channels plus the ones you are
in, and — for files — the messages in those channels that point at them. Narrowing to a channel drops
the code lane, because an index belongs to a project rather than to a conversation.

The Search tab draws the results with the matched words marked, and opens one as a **peek** with
"Open full" to the channel it was said in, because leaving the page loses the list of results. A code
hit is a link instead: it opens the file at the line, in Code mode.

A search of 100,000 messages answers in about 50 ms (the acceptance is 150 ms). Two queries do it:
one picks the top ids by rank, the second fetches those rows and the names beside them — ranking and
sorting whole rows costs several times as much (ADR-0094).
