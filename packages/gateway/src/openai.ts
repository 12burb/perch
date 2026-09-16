/**
 * The OpenAI-compatible shape of `/v1` (spec §3.4, §7.4; task 4.1).
 *
 * Perch's gateway is not a new API to learn: anything that can talk to OpenAI can talk to a Perch,
 * which is what makes Hermes, a cron script, OpenCode-as-a-custom-provider and somebody's notebook
 * work without a line of Perch-specific code. So this module is the translation and nothing else —
 * a request in OpenAI's words to the AI SDK's, and an answer back the other way. No network, no
 * credentials, no database: the api calls it on both sides of one model call.
 */
import { z } from "zod";
import type { ModelMessage } from "./models.ts";

/** A message's content: a string, or the parts array the newer clients send. */
const contentSchema = z.union([
  z.string(),
  z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      // An image or an audio part from a client Perch cannot serve yet is named, not guessed at.
      z.object({ type: z.string() }).passthrough(),
    ]),
  ),
]);

export const chatRequestSchema = z
  .object({
    /** A model profile's name, or `provider/model_id` on the workspace's allow-list (§7.4). */
    model: z.string().min(1).max(200),
    messages: z
      .array(
        z.object({
          role: z.enum(["system", "developer", "user", "assistant", "tool"]),
          content: contentSchema.nullish(),
          name: z.string().optional(),
        }),
      )
      .min(1)
      .max(500),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().min(1).max(200_000).optional(),
    max_completion_tokens: z.number().int().min(1).max(200_000).optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
    /** Accepted and ignored: who the caller is, for their own accounting. */
    user: z.string().max(200).optional(),
  })
  .passthrough();

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const embeddingsRequestSchema = z
  .object({
    model: z.string().min(1).max(200),
    input: z.union([z.string(), z.array(z.string()).min(1).max(256)]),
    dimensions: z.number().int().min(1).max(8192).optional(),
    encoding_format: z.enum(["float", "base64"]).optional(),
  })
  .passthrough();

export type EmbeddingsRequest = z.infer<typeof embeddingsRequestSchema>;

/** The text of one message, whichever shape it arrived in. */
function textOf(content: z.infer<typeof contentSchema> | null | undefined): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
}

/**
 * The request's messages, as the AI SDK takes them. `developer` is OpenAI's newer name for a
 * system message and `tool` is folded into the conversation as text: `/v1` does not run tools
 * for a caller yet, so a tool result is context rather than a call to replay.
 */
export function toMessages(request: ChatRequest): { system?: string; messages: ModelMessage[] } {
  const system = request.messages
    .filter((one) => one.role === "system" || one.role === "developer")
    .map((one) => textOf(one.content))
    .filter(Boolean)
    .join("\n\n");
  const messages: ModelMessage[] = [];
  for (const one of request.messages) {
    if (one.role === "system" || one.role === "developer") continue;
    const text = textOf(one.content);
    if (!text) continue;
    if (one.role === "assistant") messages.push({ role: "assistant", content: text });
    else if (one.role === "tool") messages.push({ role: "user", content: `[tool] ${text}` });
    else messages.push({ role: "user", content: text });
  }
  // Every provider wants at least one message; a request that was all system prompt gets a nudge.
  if (messages.length === 0) messages.push({ role: "user", content: " " });
  return { ...(system ? { system } : {}), messages };
}

/** What the AI SDK should be asked for, from what the caller asked for. */
export function toSettings(request: ChatRequest): {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
} {
  const stop = typeof request.stop === "string" ? [request.stop] : request.stop;
  const maxOutputTokens = request.max_completion_tokens ?? request.max_tokens;
  return {
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { topP: request.top_p }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(stop?.length ? { stopSequences: stop } : {}),
  };
}

export type CompletionUsage = { input: number; output: number; cached?: number };

/** An id in OpenAI's shape, because clients log it and some of them parse the prefix. */
export function completionId(): string {
  return `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
}

/** The answer to a non-streaming `chat/completions`. */
export function completionBody(input: {
  id: string;
  model: string;
  text: string;
  usage: CompletionUsage;
  finish?: "stop" | "length" | "content_filter";
  created?: number;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: "chat.completion",
    created: input.created ?? Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: input.text },
        logprobs: null,
        finish_reason: input.finish ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: input.usage.input,
      completion_tokens: input.usage.output,
      total_tokens: input.usage.input + input.usage.output,
      ...(input.usage.cached
        ? { prompt_tokens_details: { cached_tokens: input.usage.cached } }
        : {}),
    },
  };
}

/** One `data:` line of a streamed answer. */
export function chunkBody(input: {
  id: string;
  model: string;
  delta?: string;
  role?: "assistant";
  finish?: "stop" | "length" | "content_filter" | null;
  usage?: CompletionUsage;
  created?: number;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created ?? Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        delta: {
          ...(input.role ? { role: input.role } : {}),
          ...(input.delta === undefined ? {} : { content: input.delta }),
        },
        logprobs: null,
        finish_reason: input.finish ?? null,
      },
    ],
    ...(input.usage
      ? {
          usage: {
            prompt_tokens: input.usage.input,
            completion_tokens: input.usage.output,
            total_tokens: input.usage.input + input.usage.output,
          },
        }
      : {}),
  };
}

/** A server-sent event, framed the way OpenAI frames one. */
export function sse(body: Record<string, unknown> | "[DONE]"): string {
  return `data: ${body === "[DONE]" ? body : JSON.stringify(body)}\n\n`;
}

/** The answer to `embeddings`. Base64 is what the OpenAI clients ask for by default in Python. */
export function embeddingsBody(input: {
  model: string;
  vectors: readonly (readonly number[])[];
  usage: { input: number };
  format?: "float" | "base64";
}): Record<string, unknown> {
  return {
    object: "list",
    data: input.vectors.map((vector, index) => ({
      object: "embedding",
      index,
      embedding: input.format === "base64" ? base64Floats(vector) : [...vector],
    })),
    model: input.model,
    usage: { prompt_tokens: input.usage.input, total_tokens: input.usage.input },
  };
}

/** Little-endian float32s, base64 — what `encoding_format: base64` means. */
function base64Floats(vector: readonly number[]): string {
  const floats = new Float32Array(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString("base64");
}

/** A model, in the shape `GET /v1/models` answers with. */
export function modelBody(input: { id: string; ownedBy: string; created?: number }) {
  return {
    id: input.id,
    object: "model",
    created: input.created ?? Math.floor(Date.now() / 1000),
    owned_by: input.ownedBy,
  };
}

/**
 * An error in OpenAI's shape, which is what a client library parses. Perch's own `/api` errors are
 * §7.8's shape; a caller here is holding an OpenAI SDK and should get what it expects.
 */
export function errorBody(input: {
  message: string;
  type: string;
  code?: string;
  param?: string;
}): Record<string, unknown> {
  return {
    error: {
      message: input.message,
      type: input.type,
      param: input.param ?? null,
      code: input.code ?? null,
    },
  };
}
