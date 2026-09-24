---
"@perch/api": patch
"@perch/api-client": patch
"@perch/bots": patch
"@perch/bot-sdk": patch
---

Bot platform fixes from the code review (ADR-0176). A code bot whose tool answers after its run has
ended no longer crashes the api, and its 32-call limit holds for calls it never awaits. The bot
socket delivers only the bot's own workspace's events, and `users.info` answers only for people in
the bot's workspace. Keyword triggers match whole comma-separated phrases instead of every word,
and a `regex: true` pattern that could stall the api is refused when it is saved and runs on a time
budget. Tool output can no longer close the untrusted wrapper around it. `POST /api/bot/work.create`
exists behind `work:write`, and `app_mention` carries the thread's real hop, mode and remaining
budget, with outside bots held to the same hop limit and breaker. Hub installs, `bot.yaml` syncs and
the Nest follow the Forge's rules: an admin makes shared bots, a bot goes only into a channel its
installer can see, and a member's sync or skill install cannot change somebody else's bot. The Nest
skips a handle a person already has instead of failing part-way. Pending tool calls from private
channels are listed only to their members, and bot replies and deploy cards thread only under a
message in their own channel. The demo's bots are installed in #general and #the-nest. The bot SDK
reports failing handlers and dropped sockets instead of ending the process, and gains
`bot.work.create`.
