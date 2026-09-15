---
"@perch/api": minor
"@perch/web": minor
"@perch/bots": minor
"@perch/gateway": minor
"@perch/db": minor
"@perch/policy": minor
---

Bots that answer. A workspace can now make a bot, give it a persona and a brain, put it in a channel
and have it reply when it is named — streaming into its message the way a person's typing fills in,
always in the thread it was asked in. Triggers cover mentions, DMs, keywords, a bot's own arrival, a
reaction and a cron schedule; the native tools (web search, fetching a page, reading and posting in
channels, remembering and recalling, thread facts) are each the bot's own, and everything they bring
back is wrapped as untrusted so a webpage cannot tell a bot what to do. Every turn is on a ledger
with its tokens and cost, and a bot over its daily budget or its rate limit says so instead of going
quiet.
