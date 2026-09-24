# Brains: the models a workspace runs on

A **brain** is a name over a model: "Cloud" might be `gpt-5.1` on OpenAI, "Local" might be
`qwen3-coder` on the Ollama running on your laptop. A session picks a brain, and the engine it
starts gets exactly what that brain needs — nothing more (spec §3.4, §3.6 lane A; task 1.15,
ADR-0081).

Perch is open source and has no paid plan of its own (ADR-0064): every model you run here is one
you brought — a key you pay the provider for, a subscription an engine is already logged in to, or
a model on your own hardware.

## Where it lives

Workspace settings → **Brains**. Two lists:

- **Credentials** — the keys and endpoints the workspace can reach. Each row shows the provider,
  your label, a hint (`sk…4f2a`) or the base URL, and who can use it. **Test** asks the provider for
  its model list; **Remove** says which brains pointed at it.
- **Brains** — the named models. Each is a provider, a model id, and (optionally) a credential.
  One may be the workspace's **default for code**, which is what a session uses when you don't pick;
  another its **default for chat**, and another its **default for embedding**, which is what the
  codebase index uses.

## Credentials

| | |
|---|---|
| **Kind** | An **API key** (OpenAI, Anthropic, Google, Groq, Mistral, xAI, OpenRouter) or an **endpoint** (Ollama, or any OpenAI-compatible base URL under "OpenAI-compatible endpoint"). |
| **Scope** | *Only me* — a personal key, invisible to everyone else in the workspace, in the list and to any session but yours. *Everyone in the workspace* — a shared key; adding or removing one is an admin's call. |
| **Base URL** | Optional for a key (it overrides the provider's default, which is how you point at a proxy or a gateway), required for an endpoint that has no default. |

A base URL you type is where the api itself sends every call on that credential, so on a team
instance it has to be a **public address** (ADR-0173): one that is, or resolves to, loopback, a
private range, link-local or carrier-grade NAT is refused with a `422` when the credential is added,
and the model list (**Test**) is fetched through the same checks. The provider's own default and a
`PERCH_OLLAMA_URL` are the operator's, not a member's, and are exempt — so the instance's Ollama
still works. In laptop mode private addresses are allowed; a team instance whose models live on a
private network can allow them with `PERCH_OUTBOUND_ALLOW_PRIVATE=on`.

The key is typed once. It is encrypted with the instance vault before it touches the database and
never comes back: the API answers with a hint, which is enough to tell two keys apart and useless
to anyone who reads it. No route, transcript, bus event, or log line carries a key
(AGENTS.md §1.6).

### Ollama, in one click

When you open Brains, Perch asks `PERCH_OLLAMA_URL` and then `http://127.0.0.1:11434/v1` whether
anything is listening. If something answers, the page says so and offers to add it — no typing.

## Brains (model profiles)

Add one with a name, a credential, and a model. The model box lists what the credential's provider
actually reports (that list is the same call as **Test**), and you can type an id it doesn't list.
Leave the credential as **The engine's own login** for lane B and C models: a Claude Code or Codex
subscription the engine is already signed in to, which Perch never sees, never proxies, and never
shares (spec §3.6).

**Default for** names what a brain is the workspace's default for: **Code** is what new sessions
use, **Chat** is what a bot falls back to, and **Embedding** is what the codebase index embeds with.
Only one brain per workspace holds each title; giving it to another takes it from the first, and the
buttons on each row move a title without retyping anything.

Embedding is the one that is optional in a way the others are not: it buys the half of `@codebase`
that finds a thing by what it does rather than by its name
([`repo-intelligence.md`](repo-intelligence.md)), and without it the codebase index still exists and
still cites the right file, on Postgres full-text search alone. Any OpenAI-compatible embedding model
works, including one on a laptop's Ollama; Perch brings every vector to 1024 dimensions so the column
means the same thing whichever provider filled it.

## Starting a session on a brain

Code mode → Sessions → **New session**. The form has a **Brain** picker; leave it on *The workspace
default* to use the default-for-code brain. What the engine receives is just the environment that
brain needs — `OPENAI_API_KEY` and a base URL for an OpenAI credential, `OLLAMA_HOST` for an Ollama
endpoint — set on the agent process and on nothing else. A brain whose credential is yours alone
cannot be used by anyone else's session, even if the brain itself is visible to them.

## What Perch asks a provider

Only `GET {base}/models`, and only when you press Test or open a model picker. Perch ships no model
table: the list you see is the provider's own, so it is never out of date (ADR-0081). Anthropic and
Google do not publish that shape, so their model ids are typed rather than picked.

## Environment

| Variable | Does |
|---|---|
| `PERCH_OLLAMA_URL` | An extra place to look for a local Ollama, tried before the default port. Comma-separated for several. |
| `PERCH_OUTBOUND_ALLOW_PRIVATE` | Whether a base URL a member types may be a private, loopback or link-local address. On in laptop mode, off in team mode (ADR-0173). |

## Roles

| Action | owner | admin | member |
|---|---|---|---|
| See the brains and credentials you may use | ✅ | ✅ | ✅ |
| Add or remove a personal credential | ✅ | ✅ | ✅ |
| Add or remove a workspace credential | ✅ | ✅ | ❌ |
| Add, remove, or promote a brain | ✅ | ✅ | ❌ |

## The gateway at `/v1`

Anything that can talk to OpenAI can talk to a Perch. Point a client at your instance, use a
virtual key where the API key goes, and name a brain where the model goes:

```python
from openai import OpenAI

client = OpenAI(base_url="https://perch.example.com/v1", api_key="pk_…")
client.chat.completions.create(model="chat", messages=[{"role": "user", "content": "hello"}])
```

Three endpoints: `POST /v1/chat/completions` (streamed and not), `GET /v1/models`, and
`POST /v1/embeddings`. `model` is a brain's name, or `provider/model_id`, or the bare model id —
whichever the caller has configured — as long as the key may name it.

The credential never leaves the server. That is the whole point: a script, a cron job, Hermes or
OpenCode-as-a-custom-provider gets an answer, and the workspace's key stays in the vault.

Every answer carries what it cost:

| Header | What it says |
|---|---|
| `Perch-Provider` | who actually answered — which matters when a fallback did |
| `Perch-Input-Tokens`, `Perch-Output-Tokens` | what the provider reported |
| `Perch-Cost-Usd` | what that came to, from the price table |
| `Perch-Budget-Remaining` | what is left of this key's budget, when it has one |

A streamed answer cannot carry its cost in a header — the headers are gone before the last token
is — so the usage rides in the final chunk, the way OpenAI's `stream_options.include_usage` does.

Errors are OpenAI's shape rather than Perch's (`{"error": {"message", "type", "code"}}`), because a
client library parses them: `401 invalid_api_key`, `404 model_not_found`, `402 budget_exceeded`,
`502 upstream_failed`.

## Virtual keys

```
POST   /api/workspaces/{ws}/virtual-keys  {name, subject_type, subject_id?, budget?, models?, expires_at?}
→ {key: "pk_…", virtual_key: {…}}
GET    /api/workspaces/{ws}/virtual-keys
DELETE /api/workspaces/{ws}/virtual-keys/{id}
```

Minting one is an admin's act, and the key is **shown exactly once** — the row keeps a hash and the
first few characters so a list can tell two keys apart. A key speaks as somebody: a person, a bot,
a runner, or nobody in particular (`external`), which decides whose credentials it can reach. A
key that speaks as nobody can only use workspace credentials, never a personal one.

`models` narrows a key to some of the workspace's brains; empty means all of them. `budget` is
`{limit_usd, period}` over a day, a month, or the key's whole life, counted from the ledger. A key
that has spent it is refused with `402` before any provider is called. Revoking is a one-way door,
and what the key spent stays in the ledger.

## Fallback chains

A brain can name others to try when its provider will not answer:

```
POST /api/workspaces/{ws}/model-profiles  {name: "flaky", …, fallbacks: ["chat"]}
```

The gateway walks the chain in order and answers with whichever one spoke, saying so in
`Perch-Provider`. A fallback the key may not name is skipped rather than refused: a chain is a
preference, not a promise about somebody else's key.

## The ledger

Every call through the gateway writes a row in `usage_events`: the workspace, who made it, which
key, the provider and model, the tokens, and what it cost. `usage.recorded` goes out on the bus
with the same facts. Budgets are counted from it, and the usage dashboard is drawn from it.

## Budgets

A ceiling for the workspace, for a person, or for a bot:

```
PUT    /api/workspaces/{ws}/budgets  {subject_type, subject_id?, limit_usd, period, warn_at?}
GET    /api/workspaces/{ws}/budgets
DELETE /api/workspaces/{ws}/budgets/{id}
```

`period` is `day`, `month` or `total`, counted from the ledger. `warn_at` is the fraction worth a
word before the limit is reached — 0.8 by default, and `budget.warning` goes out on the bus when
the spend crosses it.

Every ceiling above a spender applies, and the tightest one wins: a bot inside its own budget is
still inside its owner's, and both are inside the workspace's. What a budget stops is the **next**
call, not the one in flight:

- a `/v1` request gets `402 budget_exceeded` before any provider is called;
- a bot says so in the thread where it was asked, because silence looks like a broken bot.

A bot also has its own budget in its spec (`dailyUsd`, `perRunUsd`, `perThreadUsd`) and the
workspace's `policy.yaml` can cap that; those narrow a bot and never widen it.

## What it cost, on one screen

**Settings → Spending** draws the ledger: what the workspace has spent, grouped by model, by
provider, by who, or by day, with the budgets and where each one stands underneath. The same
question over REST:

```
GET /api/workspaces/{ws}/usage?from&to&group_by=model|provider|actor|day|key
→ {group_by, total_usd, slices: [{key, calls, input_tokens, output_tokens, cost_usd}]}
```

## Not here yet

Per-brain parameters (temperature and the rest) and tool policy have columns in the schema and
nothing reading them. `/v1` does not run tools for a caller — a request with `tools` is answered as
if it had none. Coding sessions do not write to the ledger yet: an engine runs on the provider's own
credential and reports its own usage, which task 4.10's reliability work folds in.
