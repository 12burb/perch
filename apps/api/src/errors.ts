/**
 * The error model (spec §7.8, §9.1): a typed PerchError(code, message, details, status) that the error
 * handler renders as { error: { code, message, details }, request_id } with the matching HTTP status.
 * Stack traces and secrets never reach the wire.
 */
import { type ErrorResponse, PERCH_ERROR_STATUS, type PerchErrorCode } from "@perch/events";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import type { AppEnv } from "./context.ts";

export class PerchError extends Error {
  readonly code: PerchErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: PerchErrorCode,
    message: string,
    details?: Record<string, unknown>,
    status: number = PERCH_ERROR_STATUS[code],
  ) {
    super(message);
    this.name = "PerchError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  static notFound(what: string, details?: Record<string, unknown>): PerchError {
    return new PerchError("not_found", `${what} not found`, details);
  }

  static forbidden(message = "forbidden", details?: Record<string, unknown>): PerchError {
    return new PerchError("forbidden", message, details);
  }

  static validation(message: string, details?: Record<string, unknown>): PerchError {
    return new PerchError("validation", message, details);
  }

  static conflict(message: string, details?: Record<string, unknown>): PerchError {
    return new PerchError("conflict", message, details);
  }

  /** Something Perch called on the caller's behalf failed or would not answer (spec §7.8, 502). */
  static upstream(message: string, details?: Record<string, unknown>): PerchError {
    return new PerchError("upstream_failed", message, details);
  }

  toBody(requestId: string): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
      request_id: requestId,
    };
  }
}

export function fromZodError(error: ZodError, where = "input"): PerchError {
  return PerchError.validation(`invalid ${where}`, {
    issues: error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  });
}

export function isPerchError(error: unknown): error is PerchError {
  return error instanceof PerchError;
}

/** Seconds a rate-limited caller should wait, when the error said so. */
function retryAfter(details: Record<string, unknown> | undefined): number | null {
  const seconds = details?.retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds)
    : null;
}

/** Hono onError: every failure becomes the §7.8 shape; unknown errors are logged and hidden. */
export function errorHandler(error: Error, c: Context<AppEnv>): Response {
  const requestId = c.get("requestId") ?? "unknown";
  const log = c.get("log");
  if (error instanceof ZodError) {
    const perch = fromZodError(error);
    return c.json(perch.toBody(requestId), perch.status as ContentfulStatusCode);
  }
  if (isPerchError(error)) {
    if (error.status >= 500) log?.error({ err: error, code: error.code }, error.message);
    // Spec §7.3 asks a 429 to say how long to wait, and a header is where a client looks for it.
    const wait = error.code === "rate_limited" ? retryAfter(error.details) : null;
    return c.json(
      error.toBody(requestId),
      error.status as ContentfulStatusCode,
      wait === null ? {} : { "retry-after": String(wait) },
    );
  }
  log?.error({ err: error }, "unhandled error");
  const internal = new PerchError("internal", "internal error");
  return c.json(internal.toBody(requestId), 500);
}
