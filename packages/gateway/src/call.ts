/**
 * Calling a model (spec §3.4; task 4.1). The AI SDK lives in this package, so the api asks the
 * gateway for an answer rather than importing a provider SDK of its own — the same reason
 * `modelFor` is here: one place holds a decrypted key, and one place knows what a call costs.
 */
import { generateText, streamText } from "ai";
import type { LanguageModel, ModelMessage } from "./models.ts";

export type CallSettings = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
};

export type CallInput = {
  model: LanguageModel;
  system?: string | undefined;
  messages: ModelMessage[];
  settings?: CallSettings;
  signal?: AbortSignal;
};

export type CallUsage = { input: number; output: number; cached: number };

/**
 * Cached prompt tokens, when the provider says so. Not every adapter reports them and the AI SDK's
 * own type does not promise the field, so it is read off the object rather than destructured.
 */
function cachedOf(usage: unknown): number {
  const cached = (usage as { cachedInputTokens?: unknown } | null)?.cachedInputTokens;
  return typeof cached === "number" ? cached : 0;
}

export type Answer = {
  text: string;
  usage: CallUsage;
  /** `length` when the model ran out of room; everything else is a stop. */
  finishReason: string;
};

/** One answer, whole. */
export async function complete(input: CallInput): Promise<Answer> {
  const result = await generateText({
    model: input.model,
    ...(input.system ? { system: input.system } : {}),
    messages: input.messages,
    ...(input.settings ?? {}),
    ...(input.signal ? { abortSignal: input.signal } : {}),
  });
  return {
    text: result.text,
    usage: {
      input: result.usage.inputTokens ?? 0,
      output: result.usage.outputTokens ?? 0,
      cached: cachedOf(result.usage),
    },
    finishReason: result.finishReason,
  };
}

/** The same answer, a token at a time, with the usage settled once the stream is done. */
export function streamCompletion(input: CallInput): {
  textStream: AsyncIterable<string>;
  usage: () => Promise<CallUsage>;
} {
  const result = streamText({
    model: input.model,
    ...(input.system ? { system: input.system } : {}),
    messages: input.messages,
    ...(input.settings ?? {}),
    ...(input.signal ? { abortSignal: input.signal } : {}),
  });
  return {
    textStream: result.textStream,
    usage: async () => {
      const usage = await result.totalUsage;
      return {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cached: cachedOf(usage),
      };
    },
  };
}
