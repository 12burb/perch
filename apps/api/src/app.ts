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
import { registerAdmin } from "./routes/admin.ts";
import { registerAgents } from "./routes/agents.ts";
import { registerBotApi } from "./routes/bot-api.ts";
import { registerBots } from "./routes/bots.ts";
import { registerBrains } from "./routes/brains.ts";
import { registerChannels } from "./routes/channels.ts";
import { registerConnections } from "./routes/connections.ts";
import { registerDeploys } from "./routes/deploys.ts";
import { registerFiles } from "./routes/files.ts";
import { registerGit } from "./routes/git.ts";
import { registerHealth } from "./routes/health.ts";
import { registerInbox } from "./routes/inbox.ts";
import { registerInstance } from "./routes/instance.ts";
import { registerMcp } from "./routes/mcp.ts";
import { registerMcpServers } from "./routes/mcp-servers.ts";
import { registerMe } from "./routes/me.ts";
import { registerMergeQueue } from "./routes/merge-queue.ts";
import { registerMessages } from "./routes/messages.ts";
import { registerPlanning } from "./routes/planning.ts";
import { registerPolicy } from "./routes/policy.ts";
import { isPreviewRequest, registerPreview } from "./routes/preview.ts";
import { registerPreviews } from "./routes/previews.ts";
import { registerProjectEnv } from "./routes/project-env.ts";
import { registerProjectFs } from "./routes/project-fs.ts";
import { registerProjects } from "./routes/projects.ts";
import { registerPullRequests } from "./routes/pull-requests.ts";
import { registerPush } from "./routes/push.ts";
import { registerRaces } from "./routes/races.ts";
import { registerRepoIndex } from "./routes/repo-index.ts";
import { registerRunners } from "./routes/runners.ts";
import { registerSearch } from "./routes/search.ts";
import { registerSessions } from "./routes/sessions.ts";
import { registerSetup } from "./routes/setup.ts";
import { registerSpecBots } from "./routes/spec-bots.ts";
import { registerTemplates } from "./routes/templates.ts";
import { registerTerminal } from "./routes/terminal.ts";
import { registerUnfurl } from "./routes/unfurl.ts";
import { registerUsage } from "./routes/usage.ts";
import { registerV1 } from "./routes/v1.ts";
import { registerVersion } from "./routes/version.ts";
import { registerVirtualKeys } from "./routes/virtual-keys.ts";
import { registerWebhooks } from "./routes/webhooks.ts";
import { registerWork } from "./routes/work.ts";
import { registerWorkspaces } from "./routes/workspaces.ts";
import type { RunnerChannel } from "./runners/channel.ts";
import { isSetupComplete } from "./services/setup.ts";
import { createBotSocket } from "./ws/bot-socket.ts";
import type { WsServer } from "./ws/server.ts";

export type AppOptions = {
  /** Directory of the built web app to serve at /; skipped when it does not exist. */
  webDist?: string;
  /** Embedded web app (the compiled perch binary): url path → file path readable by Bun.file. */
  webAssets?: Record<string, string>;
  /** The WebSocket server for /api/ws (spec §7.2); absent in tests that only need HTTP. */
  ws?: WsServer;
  /** The runner control channel for /api/runner (spec §7.6); absent in tests that only need HTTP. */
  runnerChannel?: RunnerChannel;
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
  // Perch's own framing and isolation headers; a preview's response is the dev server's and must
  // not inherit them, or the Preview tab could not frame it (spec §5.6).
  const headers = secureHeaders({ crossOriginEmbedderPolicy: false });
  app.use("*", (c, next) =>
    isPreviewRequest(c.req.header("host"), new URL(c.req.url).pathname, deps.env.previewDomain)
      ? next()
      : headers(c, next),
  );
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

  // Nobody signs up before the setup wizard has created the admin (ADR-0057).
  app.post("/api/auth/sign-up/*", async (_c, next) => {
    if (!(await isSetupComplete(deps.db.db))) {
      throw PerchError.forbidden("complete setup before signing up", { reason: "setup_required" });
    }
    await next();
  });
  // better-auth owns /api/auth/* (spec §7.1); everything else resolves the caller first.
  app.on(["GET", "POST"], "/api/auth/*", (c) => deps.auth.handler(c.req.raw));
  if (options.runnerChannel) {
    // Runners authenticate with a connect token, not a user (spec §7.6): mounted before the user
    // authentication middleware, which never sees this route.
    app.get("/api/runner", options.runnerChannel.handler);
    app.get("/api/runner/stream/:token", options.runnerChannel.streamHandler);
  }
  // Wildcard mode is decided on the Host header, so the preview proxy is mounted before the api's
  // own routes: on a preview hostname, "/" is the dev server's, not Perch's (spec §5.6).
  registerPreview(app, deps, options.ws);
  app.use("/api/*", authenticate(deps));

  if (options.ws) {
    // Upgrades need a signed-in user (cookie or bearer); the §7.8 forbidden body is returned otherwise.
    app.get("/api/ws", requireUser, options.ws.handler);
    // Socket mode (spec §7.3; task 2.19): the bot's own token, not a person's session.
    app.get("/api/bot/socket", createBotSocket(deps, options.ws).handler);
    registerTerminal(app, deps, options.ws);
  }

  registerHealth(app, deps);
  registerVersion(app, deps);
  registerInstance(app, deps);
  registerAdmin(app, deps);
  registerSetup(app, deps);
  registerMe(app, deps);
  registerWorkspaces(app, deps);
  registerRunners(app, deps);
  registerProjects(app, deps);
  registerTemplates(app);
  registerProjectFs(app, deps);
  registerGit(app, deps);
  registerSessions(app, deps);
  registerBrains(app, deps);
  registerConnections(app, deps);
  registerMcp(app, deps);
  registerMcpServers(app, deps);
  registerPreviews(app, deps);
  registerChannels(app, deps);
  registerMessages(app, deps);
  registerBots(app, deps);
  registerBotApi(app, deps);
  registerFiles(app, deps);
  registerUnfurl(app, deps);
  registerInbox(app, deps);
  registerWork(app, deps);
  registerPlanning(app, deps);
  registerVirtualKeys(app, deps);
  registerUsage(app, deps);
  // Not an /api route and not in the OpenAPI document: /v1 is somebody else's contract.
  registerV1(app, deps);
  registerMergeQueue(app, deps);
  registerRaces(app, deps);
  registerAgents(app, deps);
  registerPullRequests(app, deps);
  registerPolicy(app, deps);
  registerProjectEnv(app, deps);
  registerDeploys(app, deps);
  registerRepoIndex(app, deps);
  registerSpecBots(app, deps);
  registerWebhooks(app, deps);
  registerPush(app, deps);
  registerSearch(app, deps);

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

  // The web app answers everything that is not an api, preview, hook, MCP, or gateway path.
  const webDist = options.webDist;
  if (webDist && existsSync(webDist)) {
    const files = serveStatic({ root: webDist });
    const index = serveStatic({ root: webDist, path: "index.html" });
    app.use("/*", (c, next) => (isReservedPath(c.req.path) ? next() : files(c, next)));
    app.get("/*", (c, next) => (isReservedPath(c.req.path) ? next() : index(c, next)));
  } else if (options.webAssets?.["/index.html"]) {
    const assets = options.webAssets;
    app.get("/*", (c, next) =>
      isReservedPath(c.req.path) ? next() : serveEmbedded(assets, c.req.path),
    );
  }

  return app;
}

/** Paths the api owns (spec §7.1, §5.6, §7.5): never answered by the web app's SPA fallback. */
export function isReservedPath(path: string): boolean {
  return /^\/(api|p|hooks|mcp|v1)(\/|$)/.test(path);
}

/** Serves an embedded asset map with the SPA fallback; hashed assets are immutable, index.html is not. */
export function serveEmbedded(assets: Record<string, string>, path: string): Response {
  const hit = assets[path];
  const file = hit ?? assets["/index.html"];
  if (!file) return new Response("not found", { status: 404 });
  const headers = new Headers();
  headers.set(
    "cache-control",
    hit && path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  );
  return new Response(Bun.file(file), { headers });
}
