# The Bot API

A Perch bot does not have to run inside Perch. The Bot API (spec §7.3) is the seam a program on your
laptop, in CI, or on somebody else's server uses to be a member of the workspace: it posts, it reads
what it is allowed to read, and it is told when somebody says its name.

It is deliberately Slack-shaped. If you have written a Slack app, you already know this API.

## The short version

```bash
npm install perch-bot-sdk
```

```ts
import { PerchBot } from "perch-bot-sdk";

const bot = new PerchBot({ url: "https://perch.example.com", token: process.env.PERCH_BOT_TOKEN! });

bot.on<{ text: string; channel_id: string; mentioned_by: { name?: string } }>(
  "app_mention",
  async (mention) => {
    await bot.chat.postMessage({
      channel: mention.channel_id,
      text: `noted, ${mention.mentioned_by.name ?? "friend"}`,
    });
  },
);

await bot.connect();
```

That is the whole program. The SDK has no dependencies — `fetch`, `WebSocket` and `FormData` are
platform globals in Bun, Node 22, Deno and a browser — so a bot is a file you can run.

## A token

Bot tokens are minted per bot, in **Settings → Bots → Bot API tokens** on the bot's card. You choose
what the token may do; the value is shown once and never again. Afterwards the list keeps a hint
(`pbot_F_I…o0c4`), when it was last used, and a Revoke button.

A token starts `pbot_`. It names exactly one bot, and a bot belongs to exactly one workspace, which
is why no Bot API call takes a workspace: a bot cannot ask about a workspace it is not in.

Over REST, the same thing:

```
GET    /api/workspaces/{ws}/bots/{bot}/tokens           # hints only
POST   /api/workspaces/{ws}/bots/{bot}/tokens           # {name, scopes, expires_in_days?} → the value, once
DELETE /api/workspaces/{ws}/bots/{bot}/tokens/{token}   # revoke
```

## Scopes

| Scope | What it allows |
|---|---|
| `chat:write` | `chat.postMessage`, `chat.update`, `chat.delete` |
| `chat:read` | `conversations.history`, `conversations.replies` |
| `channels:read` | `conversations.list`, `users.info` |
| `files:write` | `files.upload` |
| `tools:call` | `tools.call` — a connection's tools through the MCP gateway |
| `sessions:open` | `sessions.open` — an agent session on a project |
| `work:write` | work items (arrives with them, in Phase 3) |

A scope that was not minted is **refused**, not quietly narrowed: the call answers `403` and says
which scope it wanted. A bot that needs more is given a new token, by a person.

## The endpoints

All under `/api/bot/`, all with `Authorization: Bearer pbot_…`.

| Method | Path | Scope |
|---|---|---|
| POST | `chat.postMessage` `{channel, text\|blocks, thread_ts?}` | `chat:write` |
| POST | `chat.update` `{ts, text\|blocks}` | `chat:write` |
| POST | `chat.delete` `{ts}` | `chat:write` |
| GET | `conversations.list` | `channels:read` |
| GET | `conversations.history?channel&oldest&latest&limit` | `chat:read` |
| GET | `conversations.replies?ts&limit` | `chat:read` |
| GET | `users.info?user` | `channels:read` |
| POST | `files.upload` (multipart, field `file`) | `files:write` |
| POST | `tools.call` `{connection_id, tool, args}` | `tools:call` |
| POST | `sessions.open` `{project, engine?, prompt?}` | `sessions:open` |

Two rules hold everywhere:

- **A bot sees only the channels it is installed in.** `conversations.list` is its installs, and
  every other call is checked against them. Installing a bot is a person's decision, made in the
  Forge; there is no way for a bot to widen its own reach.
- **A bot edits and deletes only its own messages.** `chat.update` on somebody else's message is a
  `403`; on a message that does not exist, or one in a channel the bot is not in, a `404`.

Errors are the same shape as everywhere else in Perch (spec §7.8):

```json
{ "error": { "code": "forbidden", "message": "this token does not have sessions:open",
             "details": { "rule": "bot.scope", "scope": "sessions:open" } }, "request_id": "…" }
```

## Socket mode

```
wss://<perch>/api/bot/socket?token=pbot_…
```

The token is a query parameter because a browser's `WebSocket` cannot set a header, and an external
bot is a program that may be running in one. The socket opens with a `hello` frame naming the bot
and its scopes — `await bot.connect()` resolves on it, so nothing said afterwards is missed.

Every frame is `{ type, ts, payload }`. There is no subscribe operation: a bot's subscription **is**
its installs. Adding one would be a second permission system disagreeing with the first.

| Event | When |
|---|---|
| `message.created` | anybody says anything in a channel the bot is in — except the bot itself |
| `app_mention` | that message said the bot's handle; adds `mentioned_by`, `mode`, `root_id`, `hop`, `budget_remaining` |
| `reaction.added` | somebody reacts in one of those channels |
| `channel.joined` | somebody puts the bot in a channel |
| `interaction.received` | somebody presses a button on a block the bot posted |
| `session.completed` | an agent session in the workspace ends |

A bot never hears its own message. An echo is not an event.

## Rate limit

Sixty calls a minute, per bot (spec §7.3) — not per token, so minting a second token does not buy a
second minute. The sixty-first answers `429` with `Retry-After` in seconds; the SDK puts it on the
error as `retryAfter`:

```ts
try {
  await bot.chat.postMessage({ channel, text: "…" });
} catch (error) {
  if (error instanceof PerchBotError && error.status === 429) {
    await Bun.sleep((error.retryAfter ?? 60) * 1000);
  }
}
```

## What a bot never gets

A connection's credential. `tools.call` goes through the MCP gateway, which attaches the
connection's own delegated token upstream and hands back only the result — the bot never sees the
token, and neither does anything it writes into a channel. That is the same rule the IDE and the
agent sessions run under (see [`mcp-gateway.md`](mcp-gateway.md)).

## Other ways to write a bot

The Bot API is for bots that live outside Perch. Inside it there are three more, all in
[`bots.md`](bots.md): the Forge (a form), spec bots (`bots/<handle>/bot.yaml`), and code bots
(`export default bot({ onMessage })` in a sandbox). A native bot needs no token at all — it is
already inside.
