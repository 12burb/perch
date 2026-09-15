/**
 * The providers a brain can run on (spec §3.4, task 1.15). Each entry is what Perch needs to reach
 * one: the base URL its API lives at, how a key is passed, the environment variable an engine
 * expects it in, and whether the provider answers the OpenAI-compatible `GET /v1/models` so the
 * model picker can list what is actually available.
 *
 * A base URL here is only a default: every credential may carry its own, which is what makes
 * "endpoint providers" (Ollama, LM Studio, vLLM, llama.cpp, an aggregator) work without Perch
 * knowing about them (spec §3.6 lane A).
 */

export type ProviderKind = "api_key" | "endpoint";

export type ProviderInfo = {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Where its API lives, unless the credential says otherwise. */
  baseUrl: string;
  /** The variable an engine reads the key from, so a session can be given it (spec §3.4). */
  envVar?: string;
  /** Whether `GET {baseUrl}/models` answers the OpenAI-compatible list. */
  lists: boolean;
  /** A local endpoint Perch may look for on its own (spec §11 task 1.15 "Ollama auto-detect"). */
  local?: boolean;
};

/**
 * The built-in list. Anything else is `custom`: an OpenAI-compatible base URL the person types,
 * which is how a new provider or an aggregator arrives without a release.
 */
export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "openai",
    name: "OpenAI",
    kind: "api_key",
    baseUrl: "https://api.openai.com/v1",
    envVar: "OPENAI_API_KEY",
    lists: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "api_key",
    baseUrl: "https://api.anthropic.com",
    envVar: "ANTHROPIC_API_KEY",
    // Anthropic's list is not the OpenAI shape, so the model id is typed rather than picked.
    lists: false,
  },
  {
    id: "google",
    name: "Google",
    kind: "api_key",
    baseUrl: "https://generativelanguage.googleapis.com",
    envVar: "GEMINI_API_KEY",
    lists: false,
  },
  {
    id: "groq",
    name: "Groq",
    kind: "api_key",
    baseUrl: "https://api.groq.com/openai/v1",
    envVar: "GROQ_API_KEY",
    lists: true,
  },
  {
    id: "mistral",
    name: "Mistral",
    kind: "api_key",
    baseUrl: "https://api.mistral.ai/v1",
    envVar: "MISTRAL_API_KEY",
    lists: true,
  },
  {
    id: "xai",
    name: "xAI",
    kind: "api_key",
    baseUrl: "https://api.x.ai/v1",
    envVar: "XAI_API_KEY",
    lists: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "api_key",
    baseUrl: "https://openrouter.ai/api/v1",
    envVar: "OPENROUTER_API_KEY",
    lists: true,
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "endpoint",
    baseUrl: "http://127.0.0.1:11434/v1",
    envVar: "OLLAMA_HOST",
    lists: true,
    local: true,
  },
  {
    id: "custom",
    name: "OpenAI-compatible endpoint",
    kind: "endpoint",
    baseUrl: "",
    lists: true,
  },
];

const BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

export function providerInfo(id: string): ProviderInfo | null {
  return BY_ID.get(id) ?? null;
}

/** The base URL a credential reaches: its own, else the provider's default, without a trailing slash. */
export function baseUrlFor(provider: string, override?: string | null): string {
  const raw = override?.trim() || providerInfo(provider)?.baseUrl || "";
  return raw.replace(/\/+$/, "");
}
