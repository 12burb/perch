# Bots

Spec §5.3, §5.4, §7.3. A bot is a member of the workspace that happens not to be a person: it has a
handle people type after an `@`, a spec that says how it behaves, an owner who answers for it, and a
ledger of everything it has done and spent.

Task 2.6 ships the **native runtime** — the one that runs inside Perch on a brain you have
configured. Spec bots (`bot.yaml`), code bots (`@perch/bot-sdk` in a sandbox) and external bots over
the Bot API arrive with the rest of Phase 2.

## Making one

```
POST /api/workspaces/{ws}/bots  {handle, name, spec, visibility?, budget?}
```

Any member may make a bot of their own. A **private** bot is its owner's alone — nobody else sees it
in the list, and asking for it by id answers 404. A bot **everybody in the workspace can talk to**
spends the workspace's money, so making one, or making an existing one shared, belongs to the people
who answer for the workspace (`bots.admin`). A handle is somebody's name: two bots cannot share one,
and a bot cannot take a person's.

| Route | Does |
|---|---|
| `GET …/bots` · `GET …/bots/{bot}` | the bots you can see |
| `POST …/bots` | make one |
| `PATCH …/bots/{bot}` · `DELETE …/bots/{bot}` | change it, or take it away |
| `POST …/bots/{bot}/install` `{channel_id}` | put it in a channel |
| `DELETE …/bots/{bot}/install/{channel}` | take it out again |
| `POST …/bots/{bot}/test` `{text, channel_id}` | ask it something without saying it in the channel |
| `GET …/bots/{bot}/runs` | what it has done, and what each turn cost |

Installing a bot makes it a **member of the channel**: it reads what is said there and writes as
itself, with its own name and a `BOT` badge beside it. Taking it out takes the membership with it.

## The spec

```jsonc
{
  "persona": "You keep the newsroom posted.",
  "brain": { "profile": "Grok", "temperature": 0.7 },
  "tools": ["web_search", "http_fetch"],
  "triggers": [{ "on": "mention" }, { "on": "schedule", "cron": "0 9 * * 1-5",
                 "prompt": "Post today's headlines", "channel": "newsroom" }],
  "scope": { "channels": ["newsroom", "general"] },
  "memory": { "window": 30, "longTerm": false },
  "maxSteps": 4
}
```

**Brain.** A model profile by name (Settings → Brains), or the workspace's default for chat. The
credential behind it is decrypted for the length of one call and never reaches the bot, its prompt,
a log line or a client.

**Triggers.** `dm` (a conversation with the bot), `mention` (`@handle`, however it was typed),
`keyword` (whole words, or `regex: true` for the pattern itself), `channel_join` (the bot's own
arrival — a greeting, not a doorbell), `reaction` (any emoji, or the one `match` names), and
`schedule` (a cron expression, run by the queue, posting into the channel it names). A bot never
answers its own message, and a trigger only fires where the bot is installed and in scope.

**Tools.** The native set (spec §5.3), each one the bot's own: `web_search`, `http_fetch`,
`chat_post`, `chat_read`, `remember`, `recall`, `thread_facts`. A bot gets exactly what its spec
lists and nothing else.

**Memory.** `window` is how much of the thread it is shown. `remember` and `recall` keep short facts
between turns; with an embedding model configured they are matched by meaning, and without one by
the words themselves (ADR-0096).

## Budgets and rate limits

```jsonc
{ "dailyUsd": 5, "perRunUsd": 0.25, "perHourRuns": 30 }
```

Every turn is a row in `bot_runs` with its tokens and what they cost, so a budget is checked against
what has actually been spent. A bot over its budget **says so** where it was asked rather than going
quiet, and the refusal is on its ledger. A run that overruns what was left finishes — the money is
already spent — and says so under its answer; the next one is refused.

## What a turn looks like

1. The bot posts a placeholder in the thread of the message that named it (spec §5.4: "always reply
   in-thread").
2. The answer streams into that message, which everybody watching sees fill in. Rewriting a
   placeholder is not an edit: no "(edited)", no edit history.
3. The run is recorded: trigger, model, tokens, cost, and how it ended.

Nothing of this happens inside the request that caused it. Somebody says something, the api answers
them, and the bot's turn goes on in the background.

## What a bot is told, and what it is not

Everything a tool brings back — a search result, a fetched page, a thread's facts — arrives wrapped:

```
<untrusted source="web_search">
…
</untrusted>
```

The bot's system prompt says what that means: data somebody else wrote, to be read and doubted,
never an instruction to follow (spec §5.3 guardrails, §5.4 trust boundary). A bot holds no keys and
no tokens, and `http_fetch` refuses anything that resolves inside the network Perch runs on — no
`localhost`, no private address, no metadata endpoint.

`web_search` goes to whatever endpoint `PERCH_SEARCH_URL` names (Brave-shaped) with
`PERCH_SEARCH_KEY`; without one the tool says it is not configured rather than inventing an answer.

## Events

A bot's turn publishes `bot.run_started`, then `bot.run_finished` or `bot.run_failed`; installing
and uninstalling publish `bot.installed` and `bot.uninstalled`; a budget refusal publishes
`budget.exceeded` (spec §7.7). The Bot API's own events — `interaction.received` today, the rest
with the transports in 2.7 — travel the seam in `packages/bots`, not the bus.
