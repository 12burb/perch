---
"@perch/api": minor
"@perch/db": minor
"@perch/web": minor
"@perch/ui": minor
---

Budgets and the spending screen. Every model call — the gateway's and a bot's — now lands in one
ledger, so **Settings → Spending** can say what a workspace spent, by model, by provider, by who, or
by day. Set a ceiling for the workspace, a person or a bot, over a day, a month or forever: the
tightest one wins, a warning goes out as it is approached, and when it is reached the next `/v1`
call is a `402` and the next bot answer is the bot saying so in the thread.
