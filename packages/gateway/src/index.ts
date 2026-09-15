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
  baseUrlFor,
  PROVIDERS,
  type ProviderInfo,
  type ProviderKind,
  providerInfo,
} from "./providers.ts";
