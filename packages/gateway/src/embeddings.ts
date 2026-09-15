/**
 * Turning text into a vector (spec §3.4, §7.4 `/v1 … embeddings`; task 2.17).
 *
 * The same one code path the catalog uses: every provider Perch can embed with answers the
 * OpenAI-compatible `POST {base}/embeddings`, so OpenAI, an aggregator and a laptop running Ollama
 * are the same request. The key goes out in one header and appears in no result, error, or log.
 *
 * `repo_index.embedding` is `vector(1024)` (spec §6) and providers return whatever width their
 * model has, so every vector is brought to 1024 here — asked for where the provider supports it,
 * and folded where it does not (ADR-0110). What matters for search is that every vector in a
 * column was made the same way, which `fit` guarantees.
 */
import { baseUrlFor } from "./providers.ts";

/** Just enough of fetch to make a request; the global is assignable, and so is a test's stub. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What spec §6 gives an embedding column, and therefore what everything here produces. */
export const EMBEDDING_DIMENSIONS = 1024;

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export type EmbedRequest = {
  provider: string;
  model: string;
  input: readonly string[];
  baseUrl?: string | null;
  apiKey?: string | null;
  timeoutMs?: number;
  fetch?: FetchLike;
};

/**
 * A vector at exactly `EMBEDDING_DIMENSIONS`, whatever width it arrived at.
 *
 * Shorter is padded with zeros. Longer is folded — each output component is the sum of every input
 * component that lands on it — rather than truncated, because truncation throws away the tail of a
 * model's vector and folding keeps its contribution. Then it is normalised, so cosine distance is
 * the same measure whichever provider produced it.
 */
export function fit(vector: readonly number[], dimensions = EMBEDDING_DIMENSIONS): number[] {
  const out = new Array<number>(dimensions).fill(0);
  for (let at = 0; at < vector.length; at++) {
    const value = vector[at] ?? 0;
    const to = at % dimensions;
    out[to] = (out[to] ?? 0) + value;
  }
  let length = 0;
  for (const value of out) length += value * value;
  length = Math.sqrt(length);
  if (length === 0) return out;
  return out.map((value) => value / length);
}

function readVectors(body: unknown): number[][] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new EmbeddingError("that provider answered no embeddings");
  const rows: { index: number; embedding: number[] }[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { index?: unknown; embedding?: unknown };
    if (!Array.isArray(row.embedding)) continue;
    rows.push({
      index: typeof row.index === "number" ? row.index : rows.length,
      embedding: row.embedding.map((value) => (typeof value === "number" ? value : 0)),
    });
  }
  // A provider may answer out of order; `index` is what says which input each vector is for.
  rows.sort((a, b) => a.index - b.index);
  return rows.map((row) => fit(row.embedding));
}

/** One batch of text, as vectors, in the order it went in. */
export async function embed(request: EmbedRequest): Promise<number[][]> {
  if (request.input.length === 0) return [];
  const base = baseUrlFor(request.provider, request.baseUrl);
  if (!base) throw new EmbeddingError("this credential has no base URL to ask");
  const call: FetchLike = request.fetch ?? fetch;
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`;
  let response: Response;
  try {
    response = await call(`${base}/embeddings`, {
      method: "POST",
      headers,
      // `dimensions` is a request, not a promise: a provider that ignores it is folded by `fit`.
      body: JSON.stringify({
        model: request.model,
        input: [...request.input],
        dimensions: EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
    });
  } catch (error) {
    // Never repeat the request back: it carries the key in a header.
    const reason = error instanceof Error ? error.message : String(error);
    throw new EmbeddingError(`could not reach ${base}: ${reason}`);
  }
  if (!response.ok) {
    throw new EmbeddingError(
      `${base} answered ${response.status} ${response.statusText}`.trim(),
      response.status,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EmbeddingError(`${base} did not answer JSON`);
  }
  const vectors = readVectors(body);
  if (vectors.length !== request.input.length) {
    throw new EmbeddingError(
      `asked ${base} for ${request.input.length} embeddings and got ${vectors.length}`,
    );
  }
  return vectors;
}
