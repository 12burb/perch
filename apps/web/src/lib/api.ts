import { type components, createPerchClient } from "@perch/api-client";

/** The typed REST client, same origin, cookie-authenticated. */
export const api = createPerchClient({ baseUrl: window.location.origin });

export type ApiError = components["schemas"]["Error"];

export class RequestFailed extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, body: ApiError | undefined) {
    super(body?.error.message ?? `request failed with ${status}`);
    this.code = body?.error.code ?? "internal";
    this.status = status;
  }
}

/** Turns an openapi-fetch result into data or a thrown RequestFailed. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || result.data === undefined) {
    throw new RequestFailed(result.response.status, result.error as ApiError | undefined);
  }
  return result.data;
}
