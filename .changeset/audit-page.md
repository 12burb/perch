---
"@perch/api": minor
"@perch/web": minor
---

The audit log grew up. **Settings → Audit log** now shows who did what and when in a table that
narrows by action, by actor (a person, a bot, a runner, or Perch itself) and by a range of days,
and **Export CSV** takes the same view away as a file — with fields that cannot turn into formulas
when the spreadsheet opens.

How long the log is kept is now a setting: `PATCH /api/admin/settings` with
`audit_retention_days` (0, the default, keeps everything), pruned nightly an hour after the backup
so nothing is deleted before it has been copied. `GET /api/admin/audit` is the same query across
every workspace, for the account the instance was set up with.

And a test that reads every route: `apps/api/test/authorized.test.ts` checks that each one decides
whether the caller may do what they asked — the policy check, a Bot API scope, or the instance
guard — and that anything without one is named with the reason it needs none.
