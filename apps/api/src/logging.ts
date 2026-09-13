/**
 * pino logging (spec §9.1): one line per request with request_id, workspace_id, user_id; secrets
 * redacted by key list; OTLP export stays off unless PERCH_OTLP_ENDPOINT is set (task 3.x).
 */
import type { MiddlewareHandler } from "hono";
import pino, { type Logger, type LoggerOptions } from "pino";
import type { AppEnv } from "./context.ts";
import { REDACTED_KEYS } from "./env.ts";

export type { Logger };

export function createLogger(options: { level: string; pretty?: boolean; name?: string }): Logger {
  const redactPaths = REDACTED_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `req.headers.${k}`]);
  const base: LoggerOptions = {
    name: options.name ?? "perch",
    level: options.level,
    redact: { paths: redactPaths, censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined,
  };
  if (options.pretty) {
    return pino({
      ...base,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l" },
      },
    });
  }
  return pino(base);
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
        path: c.req.path,
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
