# The inbox

One queue of things waiting for you: permission prompts an agent is parked on, mentions, threads the
rails paused, budgets a bot has run through, and runs that failed (spec §5.7). It is personal and it
crosses workspaces — what needs you is what needs you, wherever it happened.

## Where items come from

Nothing puts an item in the inbox on purpose. The inbox subscribes to the bus, like push and the
audit log do, and turns what it hears into rows:

| Event | Kind | Who gets it |
|---|---|---|
| `session.permission_requested` | `permission` | whoever the session belongs to |
| `bot.chain_breaker` | `chain` | whoever started the thread |
| `budget.exceeded` (a bot) | `budget` | the bot's owner |
| `bot.run_failed` | `bot_failure` | the bot's owner |
| `message.created` naming you | `mention` | everybody named who is in the channel |

`session.permission_answered` resolves the permission item, wherever it was answered — from the
session pane, from the inbox, or from another device.

An item is one row per person per thing: the same event arriving twice does not ask the same
question twice, and a thing that happens again after being resolved opens the item again.

## Reading it

Inbox mode's four sections are the same queue asked for differently, and the ask is in the URL:

| Section | What it asks for |
|---|---|
| Needs you | everything open |
| Mentions | open items of kind `mention` |
| Threads | open items of kind `chain` |
| Later | what has been snoozed |

A snooze that has run out is open again the next time the queue is read — nothing sweeps the table.

On a phone, **Inbox is the launch tab when something needs you** (spec §4): opening Perch at `/`
lands on Inbox when the queue has anything in it, and on Home when it does not.

## Acting on it

A permission is answered where it is read: **Approve** and **Deny** on the row call the session's
own endpoint, so an agent can be let through from a phone without opening the session. Choosing
several rows and pressing **Approve** answers all the permissions among them at once.

Everything else is **Done** (resolved) or **Later** (snoozed until tomorrow morning), one row at a
time or several at once.

```
GET  /api/inbox?status=open|snoozed|resolved|all&kind=<kind>&limit=<n>
     → { items: [{ id, workspace_id, kind, ref_type, ref_id, status, title, body, url, … }], open }
POST /api/inbox/{id}/resolve
POST /api/inbox/{id}/snooze   { until?: <RFC 3339> }
```

Items arrive live on the `inbox:<user>` WS topic, which is that person's alone.
