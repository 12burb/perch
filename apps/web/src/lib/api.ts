import { type components, createPerchClient } from "@perch/api-client";

/** The typed REST client, same origin, cookie-authenticated. */
export const api = createPerchClient({ baseUrl: window.location.origin });

export type ApiError = components["schemas"]["Error"];

export class RequestFailed extends Error {
  readonly code: string;
  readonly status: number;
  /** What the error carried besides its message (spec §7.8) — a policy's rule and its findings. */
  readonly details: Record<string, unknown> | undefined;
  constructor(status: number, body: ApiError | undefined) {
    super(body?.error.message ?? `request failed with ${status}`);
    this.code = body?.error.code ?? "internal";
    this.status = status;
    this.details = body?.error.details;
  }
}

/** Turns an openapi-fetch result into data or a thrown RequestFailed. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || result.data === undefined) {
    throw new RequestFailed(result.response.status, result.error as ApiError | undefined);
  }
  return result.data;
}
