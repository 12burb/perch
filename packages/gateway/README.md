# @perch/gateway

AI SDK provider registry, model catalog, /v1 handlers, cost tables (spec §3.4).

## Today (task 1.15)

- `PROVIDERS` — the providers a brain can run on: the base URL its API lives at, the environment
  variable an engine reads its key from, and whether it publishes the OpenAI-compatible model list.
  `custom` is an OpenAI-compatible base URL the person types, which covers LM Studio, vLLM,
  llama.cpp, a proxy, and whatever ships next.
- `listModels({provider, baseUrl, apiKey})` — what a credential can actually reach, asked of the
  provider's own `GET {base}/models`. Perch ships no model table, so the list is never stale
  (ADR-0081). Throws `CatalogError` with the HTTP status when the provider refuses.
- `detectOllama({urls})` — the first URL that answers, so a laptop's Ollama is one click away.

Nothing here logs, stores, or returns a key: it goes out in one Authorization header and never
appears in a result or an error (AGENTS.md §1.6).

## Next

The `/v1` OpenAI-compatible handlers, virtual keys, and the cost tables arrive with Phase 3's model
gateway.
