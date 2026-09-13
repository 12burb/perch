/**
 * The Hono app (spec §7.1): every route under /api, OpenAPI at /api/openapi.json as the source of truth,
 * the Perch-Version header, the §7.8 error model, one log line per request, and the built web app
 * served from apps/web/dist when it exists.
 */
import { existsSync } from "node:fs";
import { OpenAPIHono } from "@hono/zod-openapi";
import { serveStatic } from "hono/bun";
import { secureHeaders } from "hono/secure-headers";
import { authenticate, requireUser } from "./auth/middleware.ts";
import { API_VERSION, type AppEnv, type Deps, SUPPORTED_API_VERSIONS } from "./context.ts";
import { errorHandler, fromZodError, PerchError } from "./errors.ts";
import { requestLogger } from "./logging.ts";
import { registerHealth } from "./routes/health.ts";
import { registerInstance } from "./routes/instance.ts";
import { registerMe } from "./routes/me.ts";
import { registerVersion } from "./routes/version.ts";
import { registerWorkspaces } from "./routes/workspaces.ts";
import type { WsServer } from "./ws/server.ts";

export type AppOptions = {
  /** Directory of the built web app to serve at /; skipped when it does not exist. */
  webDist?: string;
  /** The WebSocket server for /api/ws (spec §7.2); absent in tests that only need HTTP. */
  ws?: WsServer;
};

export function createApp(deps: Deps, options: AppOptions = {}): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const requestId = c.get("requestId") ?? "unknown";
        const error = fromZodError(result.error, "request");
        return c.json(error.toBody(requestId), 422);
      }
    },
  });

  app.use("*", requestLogger(deps.log));
  app.use("*", secureHeaders({ crossOriginEmbedderPolicy: false }));
  app.use("/api/*", async (c, next) => {
    const requested = c.req.header("perch-version");
    if (requested && !SUPPORTED_API_VERSIONS.includes(requested)) {
      throw PerchError.validation(`unsupported Perch-Version ${requested}`, {
        supported: [...SUPPORTED_API_VERSIONS],
      });
    }
    c.header("Perch-Version", API_VERSION);
    await next();
  });

  app.onError(errorHandler);
  app.notFound((c) => {
    const error = PerchError.notFound("route", { path: c.req.path });
    return c.json(error.toBody(c.get("requestId") ?? "unknown"), 404);
  });

  // better-auth owns /api/auth/* (spec §7.1); everything else resolves the caller first.
  app.on(["GET", "POST"], "/api/auth/*", (c) => deps.auth.handler(c.req.raw));
  app.use("/api/*", authenticate(deps));

  if (options.ws) {
    // Upgrades need a signed-in user (cookie or bearer); the §7.8 forbidden body is returned otherwise.
    app.get("/api/ws", requireUser, options.ws.handler);
  }

  registerHealth(app, deps);
  registerVersion(app, deps);
  registerInstance(app, deps);
  registerMe(app, deps);
  registerWorkspaces(app, deps);

  app.doc31("/api/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Perch API",
      version: API_VERSION,
      description:
        "The Perch REST contract (spec §7.1). Versioned by the Perch-Version header; this document is the source of truth for the generated SDKs.",
      license: { name: "AGPL-3.0-only", url: "https://www.gnu.org/licenses/agpl-3.0.html" },
    },
    servers: [{ url: deps.env.publicUrl }],
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "session", {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
    type: "http",
    scheme: "bearer",
    description:
      "An api token (SDKs, the MCP server), a pk_ virtual key (/v1, /mcp), or a bot token.",
  });

  const webDist = options.webDist;
  if (webDist && existsSync(webDist)) {
    app.use("/*", serveStatic({ root: webDist }));
    app.get("/*", serveStatic({ root: webDist, path: "index.html" }));
  }

  return app;
}
