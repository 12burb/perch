// @perch/gateway — AI SDK provider registry, model catalog, /v1 handlers, cost tables (spec §3.4).
export const packageName = "@perch/gateway";

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
  baseUrlFor,
  PROVIDERS,
  type ProviderInfo,
  type ProviderKind,
  providerInfo,
} from "./providers.ts";
