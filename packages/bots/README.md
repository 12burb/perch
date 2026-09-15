# @perch/bots

Bot runtime: triggers, tools, chains, QuickJS sandbox, Bot API handlers (spec §5.3, §5.4).

## Bot API events (spec §7.3)

`BOT_EVENTS` is the catalog a bot can be told about, and each event arrives in one envelope:

```ts
{ type: "interaction.received", botId: string | null, workspaceId: string, payload, ts }
```

These are **not** bus events. The bus catalog is spec §7.7's list and `packages/events` guards it;
this is the outward-facing shape a bot is handed, Slack-shaped so that anybody who has written a
Slack app can read it. A bot is told what happened and by whom — never a token, a key, or a
credential of any kind (AGENTS §1.6).

`createBotEvents()` is where a feature hands one over and a transport picks it up. It is
in-process, like the bus: a subscriber that throws never fails whoever caused the event, and an
event with nobody listening is not an error.

```ts
const events = createBotEvents({ onError: (error, event) => log.error({ error, event }) });
const stop = events.subscribe((event) => send(event));
await events.emit({ type: "interaction.received", botId, workspaceId, payload, ts });
```

Task 2.5 ships the envelope, the dispatcher, and `interaction.received` — the one event a person
causes on their own, by answering an interactive block. The transports (`wss://…/api/bot/socket`
and the HMAC-signed webhook) arrive with the runtime in 2.6 and its webhooks in 2.7; they subscribe
here rather than being wired into the features that emit.
