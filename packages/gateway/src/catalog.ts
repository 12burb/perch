/**
 * What models a credential can actually reach (spec §3.4 catalog, task 1.15). Perch asks the
 * provider rather than shipping a table: every provider Perch lists models for answers the
 * OpenAI-compatible `GET {base}/models`, so one code path covers OpenAI, an aggregator, and a
 * laptop running Ollama, and the list is never out of date (ADR-0081).
 *
 * The key is used here and nowhere else: it goes out in the Authorization header of this one
 * request and never appears in a result, an error, or a log line.
 */
import { baseUrlFor, providerInfo } from "./providers.ts";

export type CatalogModel = {
  id: string;
  /** What the provider calls it, when it says something other than the id. */
  name?: string;
  /** Who publishes it, when the provider says. */
  ownedBy?: string;
};

/** Just enough of fetch to make a request; the global is assignable, and so is a test's stub. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type CatalogQuery = {
  provider: string;
  /** Overrides the provider's default base URL (an endpoint credential always has one). */
  baseUrl?: string | null;
  apiKey?: string | null;
  /** How long to wait; a laptop endpoint that is not running should fail fast. */
  timeoutMs?: number;
  fetch?: FetchLike;
};

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

/** A provider's reply, kept to the fields Perch shows. Unknown fields are ignored. */
function readModels(body: unknown): CatalogModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const models: CatalogModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { id?: unknown; name?: unknown; owned_by?: unknown };
    const id = typeof row.id === "string" ? row.id : null;
    if (!id) continue;
    models.push({
      id,
      ...(typeof row.name === "string" && row.name !== id ? { name: row.name } : {}),
      ...(typeof row.owned_by === "string" ? { ownedBy: row.owned_by } : {}),
    });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** The models a credential can reach, newest listing from the provider itself. */
export async function listModels(query: CatalogQuery): Promise<CatalogModel[]> {
  const info = providerInfo(query.provider);
  if (info && !info.lists) {
    throw new CatalogError(`${info.name} does not publish a model list; type the model id`);
  }
  const base = baseUrlFor(query.provider, query.baseUrl);
  if (!base) throw new CatalogError("this credential has no base URL to ask");
  const call: FetchLike = query.fetch ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (query.apiKey) headers.authorization = `Bearer ${query.apiKey}`;
  let response: Response;
  try {
    response = await call(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(query.timeoutMs ?? 10_000),
    });
  } catch (error) {
    // Never repeat the request back: it carries the key in a header.
    const reason = error instanceof Error ? error.message : String(error);
    throw new CatalogError(`could not reach ${base}: ${reason}`);
  }
  if (!response.ok) {
    throw new CatalogError(
      `${base} answered ${response.status} ${response.statusText}`.trim(),
      response.status,
    );
  }
  try {
    return readModels(await response.json());
  } catch {
    throw new CatalogError(`${base} did not answer a model list`);
  }
}

/**
 * Where a local Ollama is, if one is running (spec §11 task 1.15 "Ollama auto-detect"). Tries the
 * URL the instance was told about first, then the default port on this machine.
 */
export async function detectOllama(options: {
  urls?: readonly string[];
  timeoutMs?: number;
  fetch?: FetchLike;
}): Promise<{ baseUrl: string; models: CatalogModel[] } | null> {
  const candidates = [...(options.urls ?? []), "http://127.0.0.1:11434/v1"];
  for (const candidate of candidates) {
    const baseUrl = candidate.trim().replace(/\/+$/, "");
    if (!baseUrl) continue;
    try {
      const models = await listModels({
        provider: "ollama",
        baseUrl,
        timeoutMs: options.timeoutMs ?? 1_500,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return { baseUrl, models };
    } catch {
      // Not here: try the next one.
    }
  }
  return null;
}
