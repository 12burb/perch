# The Bot API

A Perch bot does not have to run inside Perch. The Bot API (spec §7.3) is the seam a program on your
laptop, in CI, or on somebody else's server uses to be a member of the workspace: it posts, it reads
what it is allowed to read, and it is told when somebody says its name.

It is deliberately Slack-shaped. If you have written a Slack app, you already know this API.

## The short version

The SDK is `packages/bot-sdk` in this repository, and the release builds it as the npm package
`perch-bot-sdk`. **It is not on npm yet**: the release publishes it only when the repository has an
`NPM_TOKEN`, and none has been set, so `npm install perch-bot-sdk` answers 404 today. Until it is
there, build it from a checkout and install the directory:

```bash
bun run build:bot-sdk -- --out ./perch-bot-sdk   # in a Perch checkout: one ESM file, its types
npm install ./perch-bot-sdk                       # in your bot's project (or bun add ./perch-bot-sdk)
```

Each release run also keeps the same staged package as its `bot-sdk` workflow artifact. Once it is
published, this is one line:

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

Bot tokens are minted per bot, in **Settings → Bots → Bot API tokens** on the bot's card, by the
bot's owner or by an admin (a token acts as the bot, so seeing a bot is not enough to mint one;
ADR-0112). You choose what the token may do; the value is shown once and never again. Afterwards
the list keeps a hint (`pbot_F_I…o0c4`), when it was last used, and a Revoke button.

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
| `work:write` | `work.create` — an item on a project's board in the bot's workspace |

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
| POST | `work.create` `{project, title, description?, type?, state?, priority?, thread_ts?}` | `work:write` |

`work.create` answers `{ok, item: {id, identifier, project_id, title, type, state, priority,
thread_ts}}`. The project is one of the bot's workspace (anything else is a `404`), `thread_ts`
must be a message in a channel the bot is in, and the item's source is `bot`; the SDK has it as
`bot.work.create(…)`.

Three rules hold everywhere:

- **A bot sees only the channels it is installed in.** `conversations.list` is its installs, and
  every other call is checked against them. Installing a bot is a person's decision, made in the
  Forge; there is no way for a bot to widen its own reach.
- **A bot edits and deletes only its own messages.** `chat.update` on somebody else's message is a
  `403`; on a message that does not exist, has been deleted, or is in a channel the bot is not in, a
  `404`.
- **A bot knows only its own workspace.** `users.info` answers for people in the bot's workspace
  and `404` for anybody else, the same `404` as for nobody at all.
- **A bot sends a message's own blocks, not Perch's cards.** `text`, `code`, `file`, `tool_card`
  and the interactive blocks are a bot's to send; the cards Perch posts about its own work
  (`session_card`, `diff_card`, `race_card`, `deploy_card`, `queue_card`, `background_card`,
  `preflight_card`, `plan_card`, `webhook_card`) are written only by the service that did the work,
  and `chat.postMessage`/`chat.update` answer `422` for them (ADR-0174).

`conversations.history`'s `oldest` is a page cursor, not a tail. Message ids are made when a message
is written, not when it commits, so under concurrent posts a message can land with an id just older
than one already seen; a bot polling `oldest=<last id>` can miss it. To follow a channel as it
happens, use socket mode below, and use `history` to catch up on what came before.

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
its installs. Adding one would be a second permission system disagreeing with the first. Nothing
from another workspace ever reaches it: a bot's token names one bot, and that bot one workspace.

The socket is the one transport. Spec §7.3 also names an HMAC-signed webhook; it is not built
(ADR-0176), so a bot that cannot hold a socket open polls the endpoints above instead.

| Event | When |
|---|---|
| `message.created` | anybody says anything in a channel the bot is in — except the bot itself |
| `app_mention` | that message said the bot's handle; adds `mentioned_by`, `mode`, `root_id`, `hop`, `budget_remaining` (see below) |
| `reaction.added` | somebody reacts in one of those channels |
| `channel.joined` | somebody puts the bot in a channel |
| `interaction.received` | somebody presses a button on a block the bot posted |
| `session.completed` | an agent session in the workspace ends |
| `work_item.updated` | a work item in the workspace changes: its identifier, title, state and assignee |

A bot never hears its own message. An echo is not an event. An `interaction.received` goes to the
bot that posted the block, and a block a person posted belongs to no bot, so nobody hears it.

`app_mention` carries the thread's chain state, the same rails spec §5.4 holds Perch's own bots to
(ADR-0176): `hop` is which hop of the thread this is (a person's first tag is `1`), `mode` is how a
bot meant its tag (`consult` unless it said otherwise; `null` for a person's), and
`budget_remaining` is what is left of the thread's budget in dollars, or `null` when nothing caps
it. A mention of an outside bot is recorded as a hop, so a chain through outside bots meets the hop
limit and the repeat-pair breaker too; a hop the rails refuse, or any mention in a thread somebody
has `/stop`ped, is not delivered at all. What an outside bot spends it spends outside, so its hops
cost the thread nothing.

### When a handler fails, or the socket drops

```ts
const bot = new PerchBot({
  url, token,
  onError: (error, frame) => log.warn({ error, type: frame.type }),   // default: console.error
  onClose: ({ code, reason, requested }) => {
    if (!requested) setTimeout(() => bot.connect().catch(log.error), 5_000);
  },
});
```

A handler that throws — a refused `postMessage`, a `429` — goes to `onError`, and the other handlers
for that event still run; it never becomes an unhandled rejection that ends the process. `onClose` is
told when the socket closes after hello, with its code and reason: an api restart is `1001`. The SDK
does not reconnect by itself, because when to try again is the bot's call. A token that is refused
closes with `1008` before hello, and `connect()` rejects with the code and reason in its message.

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

## Calling a connection's tools

`tools.call` needs three things to line up, and says which one did not:

1. the token was minted with `tools:call`;
2. the connection is a **workspace** connection — a personal one is somebody's and never a bot's;
3. somebody **granted** it to this bot, in Settings → Connections or over
   `POST /api/workspaces/{ws}/connections/{id}/grants`. A grant may name the tools it covers, and a
   tool outside that list is refused by name before the provider is asked.

Every call is audited — the tool, a hash of the arguments, the outcome, and that a **bot** made it —
including the ones that were refused.

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
