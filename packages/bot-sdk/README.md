# perch-bot-sdk

Write a Perch bot: the Bot API over HTTP and socket mode, with no dependencies.

In this repository it is `@perch/bot-sdk`; the release builds it as the npm package
**`perch-bot-sdk`**. It is **not on npm yet** — the release publishes it only once the repository
has an `NPM_TOKEN` — so for now build it from a Perch checkout and install the directory:

```bash
bun run build:bot-sdk -- --out ./perch-bot-sdk   # in the Perch checkout
npm install ./perch-bot-sdk                       # in your bot's project
```

Each release run keeps the same package as its `bot-sdk` workflow artifact. Once it is published:

```bash
npm install perch-bot-sdk
```

```ts
import { PerchBot } from "perch-bot-sdk";

const bot = new PerchBot({ url: "https://perch.example.com", token: process.env.PERCH_BOT_TOKEN! });

bot.on<{ text: string; channel_id: string }>("app_mention", async (mention) => {
  await bot.chat.postMessage({ channel: mention.channel_id, text: "noted" });
});

await bot.connect();
```

`fetch`, `WebSocket` and `FormData` are platform globals in Bun, Node 22, Deno and a browser, so
there is nothing else to install.

| | |
|---|---|
| `bot.chat` | `postMessage`, `update`, `delete` |
| `bot.conversations` | `list`, `history`, `replies` |
| `bot.files` | `upload` |
| `bot.users` | `info` |
| `bot.tools` | `call` — a connection's tools, through the MCP gateway, never its credential |
| `bot.sessions` | `open` — an agent session on a project |
| `bot.work` | `create` — an item on a project's board |
| `bot.on(event, handler)` | `message.created`, `app_mention`, `reaction.added`, `channel.joined`, `interaction.received`, `session.completed`, `work_item.updated` |
| `bot.connect()` / `bot.disconnect()` | socket mode; `connect()` resolves once Perch has said hello |

A handler that throws is reported to the `onError` option (`console.error` when there is none) and
the other handlers for that event still run, so a refused call inside a handler never ends the
process. `onClose({code, reason, requested})` is told when the socket closes after hello — an api
restart, a dropped network, or your own `disconnect()` — and is where a bot that should keep
listening calls `connect()` again. A socket refused before hello rejects `connect()` with the close
code and reason (`1008` for a token Perch does not accept).

A failed call throws `PerchBotError` with `status`, `code`, `details` and — on a `429` — `retryAfter`
in seconds. An answer that is not JSON (a proxy's error page in front of Perch, a cut-off body) is a
`PerchBotError` too, with the HTTP status and the code `bad_response`; the SDK never throws from its
own parsing.

Where tokens come from, what each scope allows, and the rest of the protocol:
[`docs/bot-api.md`](../../docs/bot-api.md) (spec §5.3, §7.3).
