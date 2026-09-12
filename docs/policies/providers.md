# Provider policy: the credential matrix and the three lanes

Spec §3.6, verified against vendor terms in September 2026. Re-verify at the start of every phase. This page
decides how a credential may be used inside Perch; the connections layer (spec §3.5) decides how it is
obtained.

## Lanes

| Lane | What | Who may use it | Where it lives |
|---|---|---|---|
| **A — API keys and OpenAI-compatible endpoints** | OpenAI, Anthropic, xAI, Google, Mistral, Groq, DeepSeek, OpenRouter, any AI SDK provider; Ollama, LM Studio, vLLM, llama.cpp, LiteLLM, Cloudflare AI Gateway, OpenCode Zen, the Nous Portal proxy | The owner, or the whole workspace when an admin shares it | The encrypted vault on the Perch host. Served through the gateway to chat bots and `/v1`; injected natively into engines for full fidelity |
| **B — Subscription OAuth inside an official or endorsed engine** | ChatGPT Plus/Pro, SuperGrok, GitHub Copilot via OpenCode `/connect`; Nous Portal via Hermes | The user only, in their own sessions and private bots | The user's home volume on a hosted or local runner. Never the vault, never proxied |
| **C — Official CLIs in the terminal** | Claude Code (Claude Pro/Max), Codex CLI, Gemini CLI, Hermes, the OpenCode TUI | The user only, under their own login | The user's home volume. Perch is a terminal here, not a harness |

## Hard rules

1. **Shared means keys or local.** A bot visible to more than one person, a cron job, a webhook automation,
   or anything else multi-user runs on Lane A or a local model. Lane B and C credentials are user-scoped and
   non-transferable.
2. **Perch never implements a vendor's OAuth itself and never spoofs a client id.** Lane B is whatever the
   endorsed engine does on its own.
3. **Tokens never leave Perch.** Engines, bots, and external agents reach connected services only through the
   MCP gateway or `tools.call`, under a grant, with audit. Perch never forwards a caller's bearer token
   upstream.
4. **Anthropic is API key only** in engines and bots. Claude subscriptions are not permitted in third-party
   harnesses; the compliant way to use a Claude plan inside Perch is Lane C. The `cli-harness` adapter for
   Claude Code stays off until Anthropic's terms for GUI wrappers are confirmed.
5. **`cli-harness`** (Codex `exec --json`, Gemini CLI, and others in their documented headless modes) is a
   feature flag, off by default, personal scope only, and re-verified against each vendor's current terms
   before it is enabled by default.

## Vendor status (September 2026)

| Brain | API key | Subscription in Perch | Notes |
|---|---|---|---|
| OpenAI | yes | ChatGPT Plus/Pro (personal, Lane B via OpenCode `/connect`, or Codex CLI in Lane C) | Applies only when the engine hits OpenAI's own Codex endpoint; cannot be proxied |
| xAI (Grok) | yes | SuperGrok (personal, Lane B via OpenCode) | Workspace Grok bots run on the API key |
| Anthropic (Claude) | yes | no in any third-party harness | Lane C only (Claude Code in the terminal) |
| Nous (Hermes) | via OpenRouter or any key | Nous Portal (personal, Lane B via Hermes) | Portal proxy usable as a Lane A endpoint |
| GitHub Copilot | — | personal, Lane B via OpenCode | |
| Google (Gemini) | yes | terminal lane only | Gemini CLI in Lane C; API key for bots |
| Local (Ollama, LM Studio, vLLM, llama.cpp) | n/a | free | Lane A endpoints |
| Aggregators (OpenRouter, Cloudflare AI Gateway, OpenCode Zen, LiteLLM) | yes | — | Lane A endpoints, never components |

"Any subscription" means any subscription the vendor allows outside its own client. The lanes are built to
swap when those answers change; the core never depends on Lane B.
