// @perch/gateway — AI SDK provider registry, model catalog, /v1 handlers, cost tables (spec §3.4).
export const packageName = "@perch/gateway";

export {
  type Answer,
  type CallInput,
  type CallSettings,
  type CallUsage,
  complete,
  streamCompletion,
} from "./call.ts";
export {
  CatalogError,
  type CatalogModel,
  type CatalogQuery,
  detectOllama,
  type FetchLike,
  listModels,
} from "./catalog.ts";
export {
  EMBEDDING_DIMENSIONS,
  EmbeddingError,
  type EmbedRequest,
  embed,
  fit,
} from "./embeddings.ts";
export type { LanguageModel, ModelMessage } from "./models.ts";
export {
  costOf,
  type ModelPrice,
  type ModelRequest,
  modelFor,
  PRICES,
  priceOf,
} from "./models.ts";
export {
  type ChatRequest,
  type CompletionUsage,
  chatRequestSchema,
  chunkBody,
  completionBody,
  completionId,
  type EmbeddingsRequest,
  embeddingsBody,
  embeddingsRequestSchema,
  errorBody,
  modelBody,
  sse,
  toMessages,
  toSettings,
} from "./openai.ts";
export {
  baseUrlFor,
  PROVIDERS,
  type ProviderInfo,
  type ProviderKind,
  providerInfo,
} from "./providers.ts";
