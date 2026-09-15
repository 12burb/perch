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
  One may be the workspace's **default for code**, which is what a session uses when you don't pick.

## Credentials

| | |
|---|---|
| **Kind** | An **API key** (OpenAI, Anthropic, Google, Groq, Mistral, xAI, OpenRouter) or an **endpoint** (Ollama, or any OpenAI-compatible base URL under "OpenAI-compatible endpoint"). |
| **Scope** | *Only me* — a personal key, invisible to everyone else in the workspace, in the list and to any session but yours. *Everyone in the workspace* — a shared key; adding or removing one is an admin's call. |
| **Base URL** | Optional for a key (it overrides the provider's default, which is how you point at a proxy or a gateway), required for an endpoint that has no default. |

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

Tick **Default for code** to make a brain the one new sessions use. Only one brain per workspace
holds that title; giving it to another takes it from the first.

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

## Roles

| Action | owner | admin | member |
|---|---|---|---|
| See the brains and credentials you may use | ✅ | ✅ | ✅ |
| Add or remove a personal credential | ✅ | ✅ | ✅ |
| Add or remove a workspace credential | ✅ | ✅ | ❌ |
| Add, remove, or promote a brain | ✅ | ✅ | ❌ |

## Not here yet

Per-brain parameters (temperature and the rest), tool policy, and cost caps have columns in the
schema and nothing reading them; the `chat` default waits for chat sessions in Phase 2. Routing a
bot or a chat reply through a brain arrives with the model gateway of Phase 3.
