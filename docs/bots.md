# Bots

Spec §5.3, §5.4, §7.3. A bot is a member of the workspace that happens not to be a person: it has a
handle people type after an `@`, a spec that says how it behaves, an owner who answers for it, and a
ledger of everything it has done and spent.

All four ways to make one are here: the **Forge** (a form, task 2.8), a **spec bot** that lives in
a repository (`bots/<handle>/bot.yaml`, below), a **code bot** whose own JavaScript answers
(`bot.js`, below), and an **external bot** over the [Bot API](bot-api.md).

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
`keyword`, `channel_join` (the bot's own arrival — a greeting, not a doorbell), `reaction` (any
emoji, or the one `match` names), and `schedule` (a cron expression, run by the queue, posting into
the channel it names). A bot never answers its own message, and a trigger only fires where the bot
is installed and in scope.

A `keyword` trigger's `match` is a list of phrases separated by commas, and each phrase fires on its
own, whole: `"review, look at this"` fires on "ready for review" and "look at this PR", never on
"meet at noon". Case does not matter, and a space inside a phrase matches any run of spaces. With
`regex: true`, `match` is a regular expression instead, held to three rules so that no bot's pattern
can stall the api for everybody (ADR-0176): it is at most 200 characters; it may not repeat a group
that itself repeats or has alternatives (`(a+)+`, `(a|aa)*`) or refer back to a group (`\1`), which
are refused with a `422` where the bot is saved (the Forge, a Hub install, or `bot.yaml`); and it
runs in QuickJS against the first 4,000 characters of a message with 25 ms to answer, after which it
counts as no match.

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

## A bot that lives in a repository

A spec bot is a directory in one of your projects. Nothing about it is clicked:

```
bots/
  scribe/
    bot.yaml
    SYSTEM.md
    skills/
      headlines/
        SKILL.md
```

Who syncs decides how far a synced bot reaches, as in the Forge (ADR-0176). A sync by an admin
(`bots.admin`) applies the file as written, and a `bot.yaml` that does not say `visibility` makes a
bot the whole workspace can talk to. A sync by anybody else makes their bots private and never an
orchestrator: a file that asks for `visibility: workspace` or `orchestrator: true` still syncs, as a
private bot, and the report's `failed` says why. A bot somebody else synced is theirs or an admin's —
another member's sync leaves it as it was, changed or deleted in the repository or not, and says so
in `failed`. A push through the Git panel syncs as whoever pushed.

`bot.yaml` is written the way spec §5.3 writes it:

```yaml
handle: grok            # optional; the folder's name otherwise
name: Grok
persona: ./SYSTEM.md    # or the text itself, inline
brain:
  model: Newsroom brain # the name of a model profile in this workspace
  temperature: 0.7
tools: [web_search, http_fetch]
triggers:
  - dm
  - mention
  - schedule: "0 9 * * 1-5"
    prompt: Post today's gaming + crypto headlines
    channel: newsroom
scope:
  channels: [newsroom, general]
memory: {window: 30, long_term: false}
budget: {daily_usd: 5}
visibility: workspace
```

Keys are written in the file the way the spec writes them (`daily_usd`, `long_term`, `max_steps`)
and stored the way §6 stores them. `model:` names a **model profile**, not a vendor's model id: a
self-hosted Perch reaches every model through a profile, which is where the credential and the
policy live (ADR-0116).

`SYSTEM.md` is the persona — what the bot was told about itself. Each `skills/**/SKILL.md` is one
skill in the Agent Skills format: YAML frontmatter with `name` and `description`, then the
instructions. A skill with no frontmatter takes its name from its folder.

### A bot that is code

Put a `bot.js` beside the `bot.yaml` and the bot stops asking a model anything — its own JavaScript
answers:

```js
export default bot({
  async onMessage(event, perch) {
    perch.log("heard", event.text);
    await perch.chat_post({ channel: event.channel, text: "noted" });
    return "and I said so out loud";
  },
  async onSchedule(event, perch) {},
  async onWebhook(event, perch) {},
});
```

The handler gets the event and a `perch` object. On `perch` are **exactly the tools the bot's
`tools:` list allows** — `chat_post`, `chat_read`, `http_fetch`, `web_search`, `remember`, `recall`
and the rest — called by name and awaited. A tool the spec did not grant is not on `perch` at all,
so a code bot has no permission a Forge bot does not. `perch.log(…)` writes to the run's log.

Returning a string posts it. A handler that posts for itself and returns nothing stays quiet.

It runs in **QuickJS with no host** (ADR-0033): no `fetch`, no `process`, no `require`, no timers,
no filesystem — `perch` is the whole of the outside. And it runs under a ceiling: 200 ms of
uninterrupted JavaScript at a time, 15 seconds for the whole run including tool calls, 16 MB of
memory, and 32 tool calls — counted as they are made, so a loop that fires calls without awaiting
them is held to 32 as well. A bot that loops is stopped and says so where it was asked; the run is a
failed `bot_runs` row and nothing else in Perch notices. A tool still waiting when the run ends is
told to stop, and whatever it answers afterwards is dropped (ADR-0176).

`import` is refused rather than ignored, because a bot that thinks it imported something fails in a
way nobody can read.

### Reading them

```
POST /api/workspaces/{ws}/projects/{project}/bots/reload
→ {added: [...], updated: [...], removed: [...], failed: [{handle, error}]}
```

A **push from the Git panel does this on its own** (spec §5.3's "hot-reload on push"), and the
panel's **Reload bots** button does it after a pull or an edit. The repository is the source of
truth: a new directory becomes a bot, a changed one is rewritten, and a directory that is gone
takes its bot with it. A bot made in the Forge is never touched — the sync only ever looks at rows
that name this project.

A directory Perch cannot read does not stop the rest. Its bot is **paused**, the reason is kept on
the row and shown in the panel, and every other bot in the repository still syncs. A handle another
bot already has is refused the same way, because a handle is a name people type.

## Schedules

A `schedule` trigger wakes a bot on a timer:

```yaml
timezone: Europe/London        # the whole bot's zone; UTC when nobody says
triggers:
  - on: schedule
    cron: "0 9 * * 1-5"        # nine in the morning, weekdays, in that zone
    prompt: Post today's headlines
    channel: newsroom          # or the first channel it is in
    catch_up: true             # the default
    catch_up_grace_minutes: 60
```

**The zone matters.** `0 9 * * 1-5` is nine o'clock where the person who wrote it lives, which is a
different instant in January than in July. Perch reads the expression in the bot's `timezone` and
follows it across a daylight-saving change. A zone name this machine has never heard of is refused
when the bot is saved, not the first time it should have fired.

**Catching up.** Perch is not always up at nine. By default a firing it missed runs late — a digest
somebody still wants is still worth having — up to `catch_up_grace_minutes` (an hour). A bot whose
message only makes sense on time says `catch_up: false`, and a missed firing is skipped rather than
arriving at noon saying good morning.

**What it did.** Every firing is a `bot_runs` row like any other, and the schedules endpoint reads
them back:

```
GET /api/workspaces/{ws}/bots/{bot}/schedules
→ {schedules: [{cron, timezone, channel, next_run_at, last_run_at, last_status, …}]}
```

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

## The Nest

Perch ships a roster of agents you can install as a team (spec §5.3): **Birbus**, who runs the Nest,
and four specialists — **Dawn** (code), **Julius** (finding things out), **Paige** (writing) and
**Kimi** (what the data says). Workspace settings → Bots → The Nest, or:

```
GET  /api/workspaces/{ws}/nest     who is in it, and which of them you already have
POST /api/workspaces/{ws}/nest     {"handles": ["kimi"]}  — or {} for all of them
```

Each joins through one of two doors, and the door is what the bot becomes:

| Door | What it is | Who runs it |
|---|---|---|
| Bot API | an **external** bot with a token, minted once | wherever the agent already runs — a Hermes process, a script, a laptop |
| Hermes | an **agent bot** on the [`hermes` engine](sessions.md#the-hermes-engine-hermes-task-38) | Perch, on a project's runner |

The answer is `{installed, already, taken}`: what was made (with each Bot API agent's token, shown
this once), who was here already, and the handles a person in this workspace already has — those
agents are skipped rather than taking somebody's name, and everything else still installs.

Installing is an admin's to do, and it makes **ordinary bots**: edit them, put them in channels,
change their brains, delete them. Nothing about a Nest agent is privileged, and in particular
**installing one grants it nothing** — Kimi expects a Supabase connection, and until an admin grants
one on the Connections page it simply cannot reach it (see [connections](connections.md#who-may-use-a-connection)).

The tokens for the Bot API agents are shown once, on the install. Perch keeps only their hashes; a
token that got away is revoked and re-minted from the bot's own page.

## Agent bots

A bot with an `engine` does not answer from a model. It opens a coding session on one of its
projects and reports back in the thread (spec §5.3 "Agent bots"):

```yaml
handle: dawn
name: Dawn
engine: acp              # or opencode, or any engine this Perch has
projects: [Aviary]       # by name or id; the first is the default
connection: github       # what the push and the pull request run on (optional)
pullRequest: true        # the default; false leaves the work in the session
triggers:
  - on: mention
```

`@dawn edit the header to add a dark-mode toggle` opens a session on Aviary, as the bot's owner —
a bot has no runner of its own — and posts a **session card** in the thread with a link straight
into Code mode. Naming a project in the message picks it; otherwise the bot's first one.

While it works, everything a person would have to answer comes to them where they asked:

- **Permissions.** An engine that wants to do something it has to ask about gets an Approve / Deny
  card in the thread. Answering it answers the engine — there is no second place to go.
- **The end.** When the turn finishes, what the agent left behind is put on a branch of its own,
  read for secrets (the same gate a person's commit goes through), committed, pushed, and opened as
  a pull request. The thread gets a **diff card**: what changed, Open in IDE, and the pull request.

Nothing is silently skipped. A project with no repository, a workspace with no connection to push
with, or a change with something that looks like a credential in it all stop where they stop, and
the card says which and why. `pullRequest: false` leaves the work in the session on purpose.

## Tools from an MCP server

A bot can reach any MCP server a connection stands for — a provider's own, or one an admin pasted
the URL of — by naming the connection in its spec (spec §5.3 "MCP attach (any MCP server)"):

```yaml
mcp:
  - connection: github          # the connection's id, or its provider
    tools: [list_issues]        # optional: fewer than the grant allows, never more
```

The spec only ever *asks*. What the bot may actually reach is the grant an admin gave it on the
Connections page — the connection, the tools, and whether each one needs a person. A connection
nobody granted the bot contributes nothing and the run carries on without it.

Attached tools arrive in the turn as `mcp__<provider>__<tool>`, so an upstream cannot publish a
`remember` and have it mistaken for the native one, and every answer comes back inside the same
`<untrusted>` wrapper as a fetched page. **The credential never enters the turn**: the call goes out
through the MCP gateway, which attaches the connection's own token on the api's side of the proxy,
and the bot's context holds the tool's name, its arguments and its answer — nothing else.

### When a tool needs a person

A grant can mark tools `requires_permission` (spec §3.5). When the model calls one, nothing goes
upstream. The call is written down as pending, and the question is asked twice over: an Approve /
Deny card in the thread it came from, and an item in the inbox of whoever set the bot running — or
the bot's owner, when a schedule or a webhook did. The bot is told it has asked, and stops.

Approving runs the call then, on the connection's own token, and posts what came back in the same
thread. Whoever answers first is who it says; the grant is checked again at that moment, so a
permission taken away while the question sat there is a refusal, not a call.

```
GET  /api/workspaces/{ws}/bot-tool-calls            what is still waiting
POST /api/workspaces/{ws}/bot-tool-calls/{id}/decide  {"decision": "approved" | "denied"}
```

Deciding needs `connections.write` and membership of the channel the question was asked in: somebody
who cannot see the thread cannot answer for it. Listing follows the same rule — a call's arguments
were built from its thread, so the list shows only the calls asked in channels you can read.

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
| `fan_out` | split one job across several bots at once, and get every answer back (orchestrators only) |

### Orchestrators

A bot with **`orchestrator: true`** may split a job. `fan_out` takes the whole plan in one call —
who does what, and whether to wait for all of them, the first, or a quorum — and does three things
tagging one at a time cannot:

- **A plan card** goes in the thread: one row per specialist, what each was asked, and what it may
  spend. It is rewritten in place as answers land, so a person scrolling past sees the shape of the
  work instead of five loose messages.
- **The budget is split.** What is left of the thread's money is divided evenly among the ones
  actually tagged, and each share is that bot's alone: the first to run cannot spend what the other
  two were promised. A share is a ceiling, never an allowance of its own — when the *thread's*
  budget is gone, everybody stops.
- **One answer comes back.** Every reply returns to the orchestrator at once, wrapped as untrusted
  like anything else a tool brings back, for it to fold into a single answer of its own. That answer
  lands in the placeholder the run opened with, above the plan and the tags, which are the
  working-out.

Nothing is inherited. Each specialist still runs on its own brain, its own tools and its own grants
(spec §5.4) — a share is money, not a credential. A bot without the flag that calls `fan_out` is
told so and nobody is tagged.

### The rails

- **A bot never answers itself**, and a person's word always gets through.
- **Six hops** per conversation by default (`budget.maxHops` on the bot that started it).
- **A pair that bounces stops.** A → B → A → B is a loop, and the third leg of it is refused.
- **The thread has a budget**: `budget.perThreadUsd` on the bot that started it, spent across every
  hop that follows. When it is gone, the chain stops. A fan-out splits what is left into a share per
  specialist; a bot that spends its share stops, and the others keep theirs.
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

## Chatting with one

A bot is somebody you can talk to on your own. Home's sidebar lists every bot the workspace can talk
to; picking one opens the room you share with it — a DM with the bot in it, made the first time you
open it and found every time after.

**Every chat in that room is a thread.** What you say starts one, the bot answers in it, and "New
chat" leaves the last one behind: the bot is shown the chat it is in and nothing else, so a new chat
starts it on a clean context. The old ones stay where they are, in the picker beside the button.

**The brain can be yours to choose.** A bot whose spec says so —

```yaml
brain: { profile: "Everyday", pick: true }
```

— puts a picker in the header of the room, and what you choose is kept on that bot's install there.
It is per room, so your chat runs on what you picked and the bot goes on answering in channels the
way its maker set it up. A bot that does not say `pick: true` keeps the brain it was given, and the
api refuses the choice rather than quietly ignoring it.

```
POST  /api/workspaces/{ws}/bots/{bot}/dm              → { channel_id, brain, can_pick_brain }
PATCH /api/workspaces/{ws}/bots/{bot}/install/{channel} { brain: "The big one" | null }
```

## Events

A bot's turn publishes `bot.run_started`, then `bot.run_finished` or `bot.run_failed`; installing
and uninstalling publish `bot.installed` and `bot.uninstalled`; a budget refusal publishes
`budget.exceeded`; a tag publishes `bot.chain_hop`, and the rails stopping one publishes
`bot.chain_breaker` (spec §7.7). The Bot API's own events — `interaction.received` today, the rest
with the transports in 2.7 — travel the seam in `packages/bots`, not the bus.
