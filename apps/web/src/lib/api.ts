import { type components, createPerchClient } from "@perch/api-client";

/**
 * The typed REST client, same origin, cookie-authenticated. `globalThis.location` is the page's
 * own; read that way, the module also loads where there is no page (the unit tests of `unwrap`).
 */
export const api = createPerchClient({ baseUrl: globalThis.location?.origin ?? "" });

export type ApiError = components["schemas"]["Error"];

type ErrorFields = { code: string; message: string; details?: Record<string, unknown> };

/**
 * The §7.8 error out of whatever the body turned out to be. A proxy in front of the api (a 502
 * while it restarts, a 413, a 429) answers with text or HTML, and openapi-fetch hands that back
 * as a string, or as JSON of another shape: none of it is read as the api's error.
 */
function apiErrorOf(body: unknown): ErrorFields | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const error: unknown = body.error;
  if (typeof error !== "object" || error === null) return undefined;
  if (!("code" in error) || typeof error.code !== "string") return undefined;
  if (!("message" in error) || typeof error.message !== "string") return undefined;
  const details =
    "details" in error && typeof error.details === "object" && error.details !== null
      ? (error.details as Record<string, unknown>)
      : undefined;
  return { code: error.code, message: error.message, ...(details ? { details } : {}) };
}

export class RequestFailed extends Error {
  readonly code: string;
  readonly status: number;
  /** What the error carried besides its message (spec §7.8) — a policy's rule and its findings. */
  readonly details: Record<string, unknown> | undefined;
  constructor(status: number, body: unknown) {
    const error = apiErrorOf(body);
    super(error?.message ?? `request failed with ${status}`);
    this.code = error?.code ?? "internal";
    this.status = status;
    this.details = error?.details;
  }
}

/**
 * Turns an openapi-fetch result into data or a thrown RequestFailed. A success with no body (a
 * 204, which openapi-fetch reports as `data: undefined`) is a success: the routes that answer
 * that way have nothing to hand back.
 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error === undefined && result.response.ok) return result.data as T;
  throw new RequestFailed(result.response.status, result.error);
}
