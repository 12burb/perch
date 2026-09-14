/**
 * @perch/api-client (MIT): the TypeScript SDK, generated from /api/openapi.json (spec §7.1, ADR-0022).
 * `src/schema.d.ts` is produced by `bun run sdk:generate`; this file is the hand-written runtime.
 */
import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema.d.ts";

export type { components, operations, paths } from "./schema.d.ts";

export type PerchClient = Client<paths>;

export type PerchClientOptions = Omit<ClientOptions, "baseUrl"> & {
  /** The instance origin, e.g. https://perch.example.com. */
  baseUrl: string;
  /** An api token or a pk_ virtual key; sent as a Bearer header. */
  token?: string;
  /** Pin a REST contract version (spec §7.1). Defaults to the version this SDK was generated from. */
  perchVersion?: string;
};

export const GENERATED_API_VERSION = "2026-09-01";

export function createPerchClient(options: PerchClientOptions): PerchClient {
  const { token, perchVersion, headers, ...rest } = options;
  const merged: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      merged[key] = value;
    });
  } else if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== null && value !== undefined) merged[key] = String(value);
    }
  }
  merged["Perch-Version"] = perchVersion ?? GENERATED_API_VERSION;
  if (token) merged.Authorization = `Bearer ${token}`;
  return createClient<paths>({ ...rest, headers: merged });
}
