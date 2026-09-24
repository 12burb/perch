/**
 * The error model (spec §7.8, §9.1): a typed PerchError(code, message, details, status) that the error
 * handler renders as { error: { code, message, details }, request_id } with the matching HTTP status.
 * Stack traces and secrets never reach the wire.
 */
import { type ErrorResponse, PERCH_ERROR_STATUS, type PerchErrorCode } from "@perch/events";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
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

/** What a Postgres driver's error carries: PGlite names the index `constraint`, postgres.js `constraint_name`. */
type DriverError = {
  code?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
  cause?: unknown;
};

function asDriverError(value: unknown): DriverError | null {
  return typeof value === "object" && value !== null ? (value as DriverError) : null;
}

/**
 * Whether a database error is a unique violation (SQLSTATE 23505), optionally on one named index or
 * constraint. drizzle wraps the driver's error in its own `DrizzleQueryError`, whose message is the
 * failed SQL, so the code and the name are read from `cause` — and from the error itself, for a
 * driver call nothing wrapped. The message is never parsed: it names the query rather than the
 * constraint, which is how a retry that read it never ran (X-data-03).
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const outer = asDriverError(error);
  for (const one of [outer, asDriverError(outer?.cause)]) {
    if (one?.code !== "23505") continue;
    if (constraint === undefined) return true;
    return one.constraint === constraint || one.constraint_name === constraint;
  }
  return false;
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
  if (error instanceof HTTPException && error.status < 500) {
    // The router's own refusals — a body in a media type the route does not take (415) — are
    // the caller's mistake, in the §7.8 shape, not an internal error (ADR-0172).
    const refused = new PerchError(
      "validation",
      error.message,
      { status: error.status },
      error.status,
    );
    return c.json(refused.toBody(requestId), error.status as ContentfulStatusCode);
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
