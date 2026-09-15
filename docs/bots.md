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

## The Forge

Settings → **Bots** is where a bot is made (spec §5.3). Six templates fill the form in — Grok
Newsroom, GPT Helpdesk, Claude Reviewer, Local Llama, 12birb Editor, GAM3 TALK Show Notes — and a
template is a starting point, not something that exists: picking one writes the name, the handle,
the persona, the tools and the triggers into the form, and nothing is created until you say so.

The form is the spec below in plain words: what it is called, what people type after an `@`, what
it is told, which brain it runs on, what it may spend in a day, which tools it has, and what sets
it off. A bot everybody can talk to is a checkbox an admin sees.

Each bot on the page carries the rest: the channels it is in (tick one to put it there), what it
has spent, a pause switch, and a **test chat** — ask it something and read the answer without
saying anything in a channel. That is `POST …/bots/{bot}/test`, the same turn a channel would get
with nowhere to post it.

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

**Skills.** `skills` is what a bot knows how to do, in the Agent Skills shape: a name, the line
that says when it applies, and the instructions themselves. They are put in front of the model with
the persona, so a bot can carry a house style or a way of writing show notes without that filling
its persona.

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

## Bots tagging bots

A mention is how bots work together (spec §5.4), and it is the same mention a person writes: a bot
that says `<@gamma>` in a thread sets @gamma off exactly as a person naming them would. What makes
it safe is that every tag is a **hop**, and hops are counted.

Three tools do the tagging, and a bot only has the ones its spec lists:

| Tool | Does |
|---|---|
| `mention` | tag another bot in this thread — `consult` to ask, `fanout` to ask several |
| `wait_for_replies` | wait for the ones you tagged (`all`, `first`, or a `quorum`) and read what they said |
| `hand_off` | give the task to another bot and stop working on it yourself |

### The rails

- **A bot never answers itself**, and a person's word always gets through.
- **Six hops** per conversation by default (`budget.maxHops` on the bot that started it).
- **A pair that bounces stops.** A → B → A → B is a loop, and the third leg of it is refused.
- **The thread has a budget**: `budget.perThreadUsd` on the bot that started it, spent across every
  hop that follows. When it is gone, the chain stops.
- **The breaker pauses the thread** and posts an intervene card — what happened, how many hops, what
  it cost — with Continue and Stop. Continue lets them carry on; Stop leaves it paused. It is the
  ordinary interactive block, so it works everywhere a message does.
- **A person can stop it themselves**: `/stop` in a thread halts every bot in it, `/resume` lets them
  go on. Both are ordinary messages, so who called it is on the record.
- **Another bot's message is data**, not an instruction: what `wait_for_replies` brings back is
  wrapped as untrusted, like everything else a tool returns.

Every hop is a row in `bot_chains` — who tagged whom, how far from the message that started it, in
what mode, what it cost, and why the rails stopped it if they did. `bot.chain_hop` and
`bot.chain_breaker` go out on the bus as they happen.

```
GET /api/workspaces/{ws}/messages/{m}/chain
→ { hops: [{hop, from_name, to_name, mode, status, cost_usd, at}], cost_usd, stopped, breaker }
```

The thread's header (`ChainHeader`) is that answer in one line: who is in it, how far it went, what
it cost, and whether it is paused.

## Events

A bot's turn publishes `bot.run_started`, then `bot.run_finished` or `bot.run_failed`; installing
and uninstalling publish `bot.installed` and `bot.uninstalled`; a budget refusal publishes
`budget.exceeded`; a tag publishes `bot.chain_hop`, and the rails stopping one publishes
`bot.chain_breaker` (spec §7.7). The Bot API's own events — `interaction.received` today, the rest
with the transports in 2.7 — travel the seam in `packages/bots`, not the bus.
