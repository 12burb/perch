# @perch/bot-sdk

## 0.1.0

### Minor Changes

- 9246f90: The Bot API: a bot can now live outside Perch. Mint a token on the bot's card in the Forge — you
  choose what it may do, and the value is shown once — and a program holding it posts, reads the
  channels the bot was put in, uploads files, calls a connection's tools through the MCP gateway, and
  opens agent sessions, over Slack-shaped endpoints under `/api/bot/`. Socket mode at
  `/api/bot/socket` tells it when somebody says its name, reacts, puts it in a channel, presses one of
  its buttons, or when a session finishes. Sixty calls a minute per bot, with `Retry-After` on the
  sixty-first.
  
  `@perch/bot-sdk` is the client to write that program against: `bot.chat.postMessage(…)`,
  `bot.on("app_mention", …)`, no dependencies, published to npm as `perch-bot-sdk`.
