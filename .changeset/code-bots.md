---
"@perch/api": minor
"@perch/bots": minor
"@perch/db": minor
---

A bot can be code. Put a `bot.js` beside its `bot.yaml` in a repository and the bot answers with its
own JavaScript instead of a model: `export default bot({ onMessage, onSchedule, onWebhook })`, with
`perch.chat_post(…)` and the rest of the tools its spec allows. It runs in QuickJS with no network,
no filesystem and no host — and under a ceiling, so a bot that loops is stopped and says so where it
was asked rather than taking anything else with it.
