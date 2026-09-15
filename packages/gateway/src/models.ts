/**
 * A brain as something that can be called (spec §3.4; task 2.6). A model profile says the provider,
 * the model id and which credential to use; this turns that into a language model the AI SDK can
 * run — and it is the only place a decrypted key is held, for the length of one call.
 *
 * Every provider Perch knows about has a first-party adapter; everything else — Ollama, LM Studio,
 * vLLM, llama.cpp, an aggregator, a base URL somebody typed — is OpenAI-compatible, which is what
 * makes a new provider arrive without a release (spec §3.6 lane A).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import { baseUrlFor } from "./providers.ts";

export type ModelRequest = {
  provider: string;
  modelId: string;
  /** The credential's own base URL, when it has one. */
  baseUrl?: string | null | undefined;
  /** The decrypted key. Absent for an endpoint that needs none (a local Ollama). */
  apiKey?: string | undefined;
};

/** The language model for one call. The key lives on the returned object and nowhere else. */
export function modelFor(request: ModelRequest): LanguageModel {
  const baseURL = baseUrlFor(request.provider, request.baseUrl);
  const apiKey = request.apiKey ?? "";
  switch (request.provider) {
    case "openai":
      return createOpenAI({ apiKey, baseURL })(request.modelId);
    case "anthropic":
      return createAnthropic({ apiKey, baseURL })(request.modelId);
    case "xai":
      return createXai({ apiKey, baseURL })(request.modelId);
    case "google":
      return createGoogle({ apiKey, baseURL })(request.modelId);
    case "groq":
      return createGroq({ apiKey, baseURL })(request.modelId);
    case "mistral":
      return createMistral({ apiKey, baseURL })(request.modelId);
    default:
      // Ollama and friends want no key at all; the compatible adapter sends none when it has none.
      return createOpenAICompatible({
        name: request.provider,
        baseURL,
        ...(apiKey ? { apiKey } : {}),
      })(request.modelId);
  }
}

/** Dollars per million tokens, in and out. */
export type ModelPrice = { in: number; out: number };

/**
 * What a call costs, for the ledger a budget is checked against. Prices move, so this is a floor
 * rather than an invoice: a model nobody has priced here costs nothing, and a local model really
 * does (ADR-0096). The table is small on purpose — the families a Perch is most likely to run.
 */
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-5": { in: 1.25, out: 10 },
  "gpt-5-mini": { in: 0.25, out: 2 },
  "o3-mini": { in: 1.1, out: 4.4 },
  "claude-opus-4": { in: 15, out: 75 },
  "claude-sonnet-4": { in: 3, out: 15 },
  "claude-haiku-4": { in: 0.8, out: 4 },
  "grok-4": { in: 3, out: 15 },
  "grok-3-mini": { in: 0.3, out: 0.5 },
  "gemini-2.5-pro": { in: 1.25, out: 10 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "mistral-large": { in: 2, out: 6 },
};

export function priceOf(modelId: string): ModelPrice | null {
  const id = modelId.toLowerCase();
  const exact = PRICES[id];
  if (exact) return exact;
  // `openai/gpt-4o-2024-11-20` and `gpt-4o` are the same price; the longest prefix that matches wins.
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(PRICES)) {
    if (!id.includes(key)) continue;
    if (!best || key.length > best.key.length) best = { key, price };
  }
  return best?.price ?? null;
}

/** What those tokens cost, in dollars. Rounded to the cent's millionth, like the column. */
export function costOf(modelId: string, usage: { input: number; output: number }): number {
  const price = priceOf(modelId);
  if (!price) return 0;
  const dollars = (usage.input * price.in + usage.output * price.out) / 1_000_000;
  return Math.round(dollars * 1e6) / 1e6;
}
