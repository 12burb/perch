/**
 * pino logging (spec §9.1): one line per request with request_id, workspace_id, user_id; secrets
 * redacted by key name; OTLP export stays off unless PERCH_OTLP_ENDPOINT is set (task 3.x).
 *
 * Spec §1.6: no token, key or password ever reaches a log line. Redaction is by key name at any
 * depth (ADR-0172): a value is replaced when its key, compared case-insensitively and without
 * separators, is one of REDACTED_KEYS or ends in token, secret, key or password. pino's own path
 * list reached two levels and missed camelCase names, so the walk is done here instead.
 */
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import pretty from "pino-pretty";
import type { AppEnv } from "./context.ts";
import { REDACTED_KEYS } from "./env.ts";

export type { Logger };

const CENSOR = "[redacted]";
/** Deeper than this, a value is cut rather than walked: logs are not a place for whole graphs. */
const MAX_DEPTH = 12;
const SECRET_SUFFIXES = ["token", "secret", "key", "password"] as const;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const LISTED = new Set<string>(REDACTED_KEYS.map(normalizeKey));

/** Whether a field of this name holds a secret (and is replaced in every log line). */
export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return LISTED.has(normalized) || SECRET_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A copy of `value` with every secret-named field replaced, however deep. Errors are serialized
 * first (so what an error carries — a request config with its headers — is walked too); values
 * with their own JSON form (dates, buffers, URLs) are left to it. The input is never changed.
 */
export function scrubSecrets(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value instanceof Error) {
    return scrubSecrets(pino.stdSerializers.err(value), depth, seen);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, depth + 1, seen));
    if (!isPlainObject(value) && typeof (value as { toJSON?: unknown }).toJSON === "function") {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? CENSOR : scrubSecrets(item, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export type CreateLoggerOptions = {
  level: string;
  /** One coloured line per event instead of JSON (PERCH_LOG_PRETTY). */
  pretty?: boolean;
  name?: string;
  /** Where lines go; stdout when unset. Tests pass a stream to read what would have been written. */
  destination?: DestinationStream;
};

/**
 * One call's fields, scrubbed. An Error under `err` is left for the err serializer below, which
 * scrubs what it serializes, so the line keeps pino's usual error shape.
 */
function scrubFields(object: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (isSecretKey(key)) out[key] = CENSOR;
    else if (key === "err" && value instanceof Error) out[key] = value;
    else out[key] = scrubSecrets(value);
  }
  return out;
}

/**
 * pino applies the bindings formatter to the root logger's bindings only; a child's go straight to
 * the line. Every child made from this logger (and from its children) is scrubbed here instead.
 */
function scrubChildBindings(logger: Logger): Logger {
  const makeChild = logger.child;
  logger.child = function child(this: Logger, bindings, childOptions) {
    return makeChild.call(this, scrubSecrets(bindings) as pino.Bindings, childOptions);
  } as Logger["child"];
  return logger;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const base: LoggerOptions = {
    name: options.name ?? "perch",
    level: options.level,
    serializers: { err: (error: unknown) => scrubSecrets(error) },
    formatters: {
      log: scrubFields,
      bindings: (bindings) => scrubSecrets(bindings) as pino.Bindings,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined,
  };
  return scrubChildBindings(open(base, options));
}

function open(base: LoggerOptions, options: CreateLoggerOptions): Logger {
  if (options.pretty) {
    // pino-pretty is a runtime dependency and runs in this thread as a stream, not as a transport
    // worker resolved by name: that resolution is what failed in the published image and in the
    // compiled binary. If it still cannot start, the api logs JSON rather than failing to boot.
    try {
      const stream = pretty({
        colorize: options.destination === undefined,
        translateTime: "HH:MM:ss.l",
        sync: true,
        ...(options.destination ? { destination: options.destination } : {}),
      });
      return pino(base, stream);
    } catch (error) {
      const fallback = options.destination ? pino(base, options.destination) : pino(base);
      fallback.warn(
        { err: error },
        "PERCH_LOG_PRETTY is on but pretty output failed; logging JSON",
      );
      return fallback;
    }
  }
  return options.destination ? pino(base, options.destination) : pino(base);
}

/** A silent logger for tests. */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}

export function newRequestId(): string {
  return Bun.randomUUIDv7();
}

/**
 * Request id + one log line per request. The id comes from an incoming x-request-id (proxies, retries)
 * or is minted; it is echoed in the response and in every error body.
 *
 * The line carries the route's pattern (`/api/invites/:token`), not the concrete path: invite
 * tokens, better-auth's reset-password tokens and runner stream tokens travel in paths, and key
 * redaction cannot see inside a string (ADR-0172).
 */
export function requestLogger(root: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId =
      incoming && /^[A-Za-z0-9_.-]{8,128}$/.test(incoming) ? incoming : newRequestId();
    const log = root.child({ request_id: requestId });
    c.set("requestId", requestId);
    c.set("log", log);
    c.header("x-request-id", requestId);
    const started = performance.now();
    try {
      await next();
    } finally {
      const durationMs = Math.round((performance.now() - started) * 100) / 100;
      const line = {
        method: c.req.method,
        // The deepest route that ran: after next() the request's route index points at it.
        route: routePath(c),
        status: c.res.status,
        duration_ms: durationMs,
        workspace_id: c.get("workspaceId"),
        user_id: c.get("userId"),
      };
      if (c.res.status >= 500) log.error(line, "request");
      else if (c.res.status >= 400) log.warn(line, "request");
      else log.info(line, "request");
    }
  };
}
