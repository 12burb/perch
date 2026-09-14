/**
 * The runner control channel at /api/runner (spec §7.6, ADR-0066): a runner opens one WebSocket with
 * a connect token as the bearer, sends `runner.register` as its first message, and from then on the
 * api sends JSON-RPC requests (each with a capability token minted from the per-connection secret)
 * and the runner sends notifications (heartbeats, port changes, session events). Registration attaches
 * a RunnerLink to the registry, marks the runner row online, and publishes runner.* bus events; a
 * closed socket, or three missed heartbeats, marks it offline.
 */
import type { Bus } from "@perch/bus";
import { type Db, type Runner, runnerCapabilitiesSchema } from "@perch/db";
import {
  type ApiToRunnerMethod,
  CAP_TTL_MS,
  generateCapSecret,
  JSON_RPC_ERRORS,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  jsonRpcMessageSchema,
  mintCap,
  RUNNER_HEARTBEAT_MS,
  RUNNER_REGISTER_TIMEOUT_MS,
  type RunnerCallParams,
  type RunnerInfo,
  type RunnerLink,
  type RunnerNotification,
  type RunnerNotificationParams,
  RunnerRpcError,
  type RunnerStream,
  type RunnerToApiMethod,
  runnerToApiParams,
} from "@perch/events";
import type { Context, MiddlewareHandler } from "hono";
import type { WSContext } from "hono/ws";
import type { Logger } from "pino";
import type { AppEnv } from "../context.ts";
import { PerchError } from "../errors.ts";
import { recordHeartbeat, updateRunner } from "../repos/runners.ts";
import { authenticateRunnerToken } from "../services/runners.ts";
import type { WsServer } from "../ws/server.ts";
import type { RunnerRegistry } from "./registry.ts";
import { type SocketStream, StreamHub } from "./streams.ts";

export type RunnerChannelDeps = { db: Db; bus: Bus; registry: RunnerRegistry; log: Logger };
export type RunnerChannelOptions = {
  heartbeatMs?: number;
  registerTimeoutMs?: number;
  /** How long an api → runner request may take before the link rejects it. */
  requestTimeoutMs?: number;
  /** How long a stream token waits for its other side (tests). */
  streamWaitMs?: number;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: Timer };

/** A RunnerLink over the control socket: requests out with a capability token, notifications in. */
class WsRunnerLink implements RunnerLink {
  private readonly handlers = new Set<(notification: RunnerNotification) => void>();
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    readonly id: string,
    readonly info: RunnerInfo,
    private readonly ws: WSContext<unknown>,
    private readonly capSecret: string,
    private readonly requestTimeoutMs: number,
    private readonly streams: StreamHub,
  ) {}

  /** The socket the runner opens for a stream token (pty.open and friends). */
  openStream(token: string): Promise<RunnerStream> {
    return this.streams.open(this.id, token);
  }

  async call<M extends ApiToRunnerMethod>(
    method: M,
    params: RunnerCallParams<M>,
  ): Promise<unknown> {
    const id = `${++this.seq}`;
    const cap = await mintCap(this.capSecret, {
      ws: params.workspace_id,
      user: params.user_id,
      method,
      exp: Date.now() + CAP_TTL_MS,
    });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RunnerRpcError(
            JSON_RPC_ERRORS.internal,
            `${method} timed out after ${this.requestTimeoutMs} ms`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, cap } }));
    });
  }

  onNotification(handler: (notification: RunnerNotification) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.ws.readyState === 0 || this.ws.readyState === 1) this.ws.close(1000, "api closing");
    this.failPending("the runner connection closed");
  }

  emit(notification: RunnerNotification): void {
    for (const handler of this.handlers) handler(notification);
  }

  settle(response: JsonRpcResponse): void {
    if (response.id === null) return;
    const entry = this.pending.get(String(response.id));
    if (!entry) return;
    this.pending.delete(String(response.id));
    clearTimeout(entry.timer);
    if (response.error) {
      entry.reject(
        new RunnerRpcError(response.error.code, response.error.message, response.error.data),
      );
    } else {
      entry.resolve(response.result);
    }
  }

  failPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new RunnerRpcError(JSON_RPC_ERRORS.internal, reason));
      this.pending.delete(id);
    }
  }
}

type Session = {
  runner: Runner;
  ws: WSContext<unknown>;
  link: WsRunnerLink | null;
  registerTimer: Timer | null;
  heartbeatTimer: Timer | null;
  log: Logger;
};

function reply(ws: WSContext<unknown>, response: JsonRpcResponse): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(response));
}

function rpcError(
  id: JsonRpcRequest["id"] | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function createRunnerChannel(
  deps: RunnerChannelDeps,
  upgradeWebSocket: WsServer["upgradeWebSocket"],
  options: RunnerChannelOptions = {},
) {
  const heartbeatMs = options.heartbeatMs ?? RUNNER_HEARTBEAT_MS;
  const registerTimeoutMs = options.registerTimeoutMs ?? RUNNER_REGISTER_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const sessions = new Set<Session>();
  const streams = new StreamHub(options.streamWaitMs);

  function armHeartbeatWatchdog(session: Session): void {
    if (session.heartbeatTimer) clearTimeout(session.heartbeatTimer);
    session.heartbeatTimer = setTimeout(() => {
      session.log.warn({ heartbeatMs }, "runner missed three heartbeats; closing");
      session.ws.close(1001, "heartbeat missed");
    }, heartbeatMs * 3);
  }

  async function register(session: Session, request: JsonRpcRequest): Promise<void> {
    if (session.link) {
      reply(session.ws, rpcError(request.id, JSON_RPC_ERRORS.invalidRequest, "already registered"));
      return;
    }
    const params = runnerToApiParams["runner.register"].safeParse(request.params);
    if (!params.success) {
      reply(
        session.ws,
        rpcError(request.id, JSON_RPC_ERRORS.invalidParams, "invalid runner.register params", {
          issues: params.error.issues,
        }),
      );
      return;
    }
    if (params.data.kind !== session.runner.kind) {
      reply(
        session.ws,
        rpcError(
          request.id,
          JSON_RPC_ERRORS.invalidParams,
          `this token belongs to a ${session.runner.kind} runner, not a ${params.data.kind} one`,
        ),
      );
      return;
    }
    const capabilities = runnerCapabilitiesSchema.safeParse(params.data.capabilities);
    if (!capabilities.success) {
      reply(
        session.ws,
        rpcError(request.id, JSON_RPC_ERRORS.invalidParams, "invalid capabilities", {
          issues: capabilities.error.issues,
        }),
      );
      return;
    }
    if (session.registerTimer) clearTimeout(session.registerTimer);
    session.registerTimer = null;
    const capSecret = generateCapSecret();
    const link = new WsRunnerLink(
      session.runner.id,
      params.data,
      session.ws,
      capSecret,
      requestTimeoutMs,
      streams,
    );
    session.link = link;
    deps.registry.attach(link, { workspaceId: session.runner.workspaceId });
    const wasOnline = session.runner.status === "online";
    await updateRunner(deps.db, session.runner.id, {
      status: "online",
      name: params.data.name,
      capabilities: capabilities.data,
      lastSeenAt: new Date(),
      idleSince: new Date(),
    });
    reply(session.ws, {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        runner_id: session.runner.id,
        cap_secret: capSecret,
        heartbeat_ms: heartbeatMs,
        owner_user_id: session.runner.ownerUserId,
      },
    });
    const actor = { type: "runner" as const, id: session.runner.id };
    const payload = { workspaceId: session.runner.workspaceId, runnerId: session.runner.id };
    await deps.bus.publish("runner.registered", { ...payload, kind: params.data.kind }, { actor });
    if (!wasOnline) await deps.bus.publish("runner.online", payload, { actor });
    armHeartbeatWatchdog(session);
    session.log.info({ name: params.data.name, kind: params.data.kind }, "runner registered");
  }

  async function notification(session: Session, method: string, params: unknown): Promise<void> {
    if (!session.link) return;
    if (!Object.hasOwn(runnerToApiParams, method) || method === "runner.register") return;
    const schema = runnerToApiParams[method as RunnerToApiMethod];
    const parsed = schema.safeParse(params);
    if (!parsed.success) {
      session.log.warn({ method, issues: parsed.error.issues }, "invalid runner notification");
      return;
    }
    if (method === "runner.heartbeat") {
      armHeartbeatWatchdog(session);
      const beat = parsed.data as RunnerNotificationParams<"runner.heartbeat">;
      await recordHeartbeat(deps.db, session.runner.id, beat.sessions.length, new Date());
    }
    session.link.emit({ method, params: parsed.data } as RunnerNotification);
  }

  async function handleMessage(session: Session, text: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = jsonRpcMessageSchema.parse(JSON.parse(text));
    } catch {
      reply(session.ws, rpcError(null, JSON_RPC_ERRORS.parse, "invalid JSON-RPC 2.0 message"));
      return;
    }
    if ("method" in message) {
      if ("id" in message) {
        if (message.method === "runner.register") await register(session, message);
        else {
          reply(
            session.ws,
            rpcError(
              message.id,
              JSON_RPC_ERRORS.methodNotFound,
              `${message.method} is not a request a runner can make`,
            ),
          );
        }
        return;
      }
      await notification(session, message.method, message.params);
      return;
    }
    session.link?.settle(message);
  }

  async function teardown(session: Session, reason: string): Promise<void> {
    sessions.delete(session);
    if (session.registerTimer) clearTimeout(session.registerTimer);
    if (session.heartbeatTimer) clearTimeout(session.heartbeatTimer);
    const link = session.link;
    if (!link) return;
    session.link = null;
    await deps.registry.detach(link.id);
    await updateRunner(deps.db, session.runner.id, { status: "offline", lastSeenAt: new Date() });
    await deps.bus.publish(
      "runner.offline",
      { workspaceId: session.runner.workspaceId, runnerId: session.runner.id, reason },
      { actor: { type: "runner", id: session.runner.id } },
    );
    session.log.info({ reason }, "runner offline");
  }

  const upgrade = upgradeWebSocket((c: Context<AppEnv>) => {
    const runner = c.get("runner");
    const log = c.get("log").child({ runner: runner?.id });
    let session: Session | undefined;
    return {
      onOpen(_evt, ws) {
        if (!runner) {
          ws.close(1008, "runner token required");
          return;
        }
        session = { runner, ws, link: null, registerTimer: null, heartbeatTimer: null, log };
        sessions.add(session);
        session.registerTimer = setTimeout(() => {
          log.warn({ registerTimeoutMs }, "runner did not register in time; closing");
          ws.close(1008, `runner.register expected within ${registerTimeoutMs} ms`);
        }, registerTimeoutMs);
      },
      onMessage(evt) {
        if (!session) return;
        const active = session;
        const data = typeof evt.data === "string" ? evt.data : "";
        handleMessage(active, data).catch((error: unknown) => {
          active.log.error({ err: error }, "runner message failed");
        });
      },
      onClose(evt) {
        if (!session) return;
        const closing = session;
        session = undefined;
        teardown(closing, evt.reason || `closed (${evt.code})`).catch((error: unknown) =>
          closing.log.error({ err: error }, "runner teardown failed"),
        );
      },
    };
  });

  async function runnerFromBearer(c: Context<AppEnv>): Promise<Runner> {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const runner = token ? await authenticateRunnerToken(deps.db, token) : null;
    if (!runner) {
      throw PerchError.forbidden("a valid runner connect token is required", {
        reason: "runner_token_invalid",
      });
    }
    return runner;
  }

  /** GET /api/runner: a valid connect token as the bearer, then the WebSocket upgrade. */
  const handler: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.set("runner", await runnerFromBearer(c));
    return upgrade(c, next);
  };

  const streamUpgrade = upgradeWebSocket((c: Context<AppEnv>) => {
    const runner = c.get("runner");
    const token = c.req.param("token") ?? "";
    let stream: SocketStream | null = null;
    return {
      onOpen(_evt, ws) {
        if (!runner) {
          ws.close(1008, "runner token required");
          return;
        }
        stream = streams.attach(runner.id, token, ws);
        if (!stream) ws.close(1008, "unknown stream token");
      },
      onMessage(evt) {
        if (typeof evt.data === "string") stream?.deliver(evt.data);
      },
      onClose() {
        stream?.markClosed();
      },
    };
  });

  /** GET /api/runner/stream/:token: the runner's data socket for a token it minted (task 1.7). */
  const streamHandler: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.set("runner", await runnerFromBearer(c));
    return streamUpgrade(c, next);
  };

  return {
    handler,
    streamHandler,
    streams,
    /** Open control sockets (registered or not), for health details and tests. */
    get size() {
      return sessions.size;
    },
    /** Closes every control socket; the registry entries go with them. */
    async close(): Promise<void> {
      streams.closeAll();
      for (const session of [...sessions]) session.ws.close(1001, "api shutting down");
    },
  };
}

export type RunnerChannel = ReturnType<typeof createRunnerChannel>;
