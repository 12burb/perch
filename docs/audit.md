# The audit log

Every state change in a workspace emits a bus event, and the audit subscriber turns each one into a
row: who did it, what they did, to what, when, and from where (spec §6, §7.7). Features never write
the log themselves, so nothing can do something without being recorded — the recording is not the
feature's to remember.

## Reading it

**Settings → Audit log**, for a workspace's owners and admins (`audit.read`). The newest hundred
rows, and three filters, because those are the three things somebody knows when they come looking:

| Filter | What it narrows to |
|---|---|
| **Action** | one kind of event — `channel.created`, `session.done`, `policy.violation` — chosen from the ones this workspace has actually recorded |
| **Actor** | a person, a bot, a runner, or Perch itself |
| **From / To** | a day, or a range of days |

The filters AND together, and the page is capped rather than paged: reach further back with the
dates, and take the answer away with **Export CSV**, which carries the same filters and at most
10,000 rows.

```sh
curl -s "$PERCH/api/workspaces/$WS/audit?action=session.done&actor_type=bot&from=2026-09-01T00:00:00Z" \
  -H "authorization: Bearer $TOKEN"
curl -s "$PERCH/api/workspaces/$WS/audit/export?action=policy.violation" -H "authorization: Bearer $TOKEN"
```

A CSV field that starts with `=`, `+`, `-` or `@` is written with a leading apostrophe: a
spreadsheet executes those, and an audit export is exactly the file somebody opens without thinking
about it.

### Across the whole instance

`GET /api/admin/audit` is the same query without a workspace, for the account this instance was set
up with. It is the view for "what happened here last night", rather than "what happened in this
workspace" — and it is the only audit view that crosses a workspace boundary.

## Keeping it

An audit log that grows forever is a table nobody prunes and a compliance answer nobody can give.
**Settings → Audit log → Keep audit rows for** sets the retention in days, for whoever set the
instance up (`PATCH /api/admin/settings`); `0`, the default, keeps everything.

The prune runs nightly at 04:00 UTC — an hour after the backup, so a row that is about to go is in
last night's copy first — and deletes in batches, because a year of an instance's log is not a row
count to hold in one transaction.

## Who may read what

| | owner | admin | member | instance admin |
|---|---|---|---|---|
| A workspace's audit log | ✅ | ✅ | ❌ | (as a member) |
| Its CSV export | ✅ | ✅ | ❌ | (as a member) |
| Every workspace's log | ❌ | ❌ | ❌ | ✅ |
| Setting the retention | ❌ | ❌ | ❌ | ✅ |

Owning a workspace says nothing about the instance: the retention control is simply not there for
somebody who cannot set it, rather than there and refusing.

## Every route is authorized

`apps/api/test/authorized.test.ts` reads every `app.openapi(...)` handler in `apps/api/src/routes`
and asks whether anything in it decides that this caller may do this — the policy check
(`authorize()`), the Bot API's scope check, the instance-admin guard, or a helper that calls one of
those. A route with none of them has to be named in the test's exemption table with the reason it
needs none, and every exemption that is not public still stands behind `requireUser`.

It is a static read rather than a runtime one because the question is about *every* route, and no
test suite exercises every route. A route that forgets its check is not a failing test anywhere
else: it answers, correctly, with somebody else's data.
