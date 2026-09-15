/**
 * The runner side of the control channel (spec §7.6, ADR-0066): one WebSocket to /api/runner with the
 * connect token as the bearer, `runner.register` as the first message, heartbeats on the period the
 * api asks for, and every api → runner request checked (params, capability token, owner) before it
 * reaches a handler. A dropped connection is reopened with jittered backoff; a refused upgrade (a bad
 * or expired token) gives up after a few tries so a supervisor sees the exit.
 */
import { cpus, freemem, hostname, loadavg, totalmem } from "node:os";
import type { RunnerCapabilities } from "@perch/db";
import {
  type ApiToRunnerMethod,
  apiToRunnerParams,
  JSON_RPC_ERRORS,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  jsonRpcMessageSchema,
  type RunnerInfo,
  type RunnerNotificationParams,
  type RunnerRegisterResult,
  type RunnerToApiMethod,
  runnerRegisterResultSchema,
  verifyCap,
} from "@perch/events";
import { localCapabilities } from "./capabilities.ts";
import {
  createServices,
  errorCode,
  type HandlerOptions,
  type RunnerHandlers,
  type RunnerServices,
} from "./handlers.ts";
import { createNotifier } from "./notify.ts";
import { watchPorts } from "./ports.ts";
import { streamOverSocket } from "./streams.ts";

export type RunnerClientStatus =
  | "connecting"
  | "registering"
  | "online"
  | "reconnecting"
  | "closed";

export type RunnerLogger = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields?: Record<string, unknown>,
) => void;

/**
 * Where the api can reach this runner's listening ports (spec §5.6; task 1.18). A hosted runner is
 * a container on the api's own network, so its hostname resolves there — Docker registers the
 * container's name and short id on a user-defined network. A local or remote runner is somewhere
 * the api has no route to, so it says nothing and waits for the tunnel of task 1.19.
 */
export function previewHostOf(
  kind: RunnerInfo["kind"],
  override?: string | null,
): string | undefined {
  if (override === null) return undefined;
  const named = (override ?? process.env.PERCH_RUNNER_PREVIEW_HOST ?? "").trim();
  if (named) return named;
  return kind === "hosted" ? hostname() : undefined;
}

export type RunnerClientOptions = {
  /** The api's public URL (http or https); the socket opens at /api/runner. */
  apiUrl: string;
  /** The connect token (prt_…). */
  token: string;
  name?: string;
  kind?: RunnerInfo["kind"];
  capabilities?: RunnerCapabilities;
  versions?: Record<string, string>;
  /** Local and remote runners: requests for any other user are refused without a grant. */
  ownerUserId?: string;
  handlers?: RunnerHandlers;
  /** Options for the default handlers when `handlers` is not given (projects root, policy). */
  handlerOptions?: Omit<HandlerOptions, "notify" | "streams">;
  /** ports.changed polling period; 0 disables the watcher. */
  portsIntervalMs?: number;
  /**
   * The hostname the api reaches this runner's ports on for previews (task 1.18). Defaults to
   * PERCH_RUNNER_PREVIEW_HOST, else this container's own hostname for a hosted runner, else none.
   */
  previewHost?: string | null;
  /** Reconnect policy; false gives up on the first drop. */
  reconnect?: { minMs?: number; maxMs?: number; maxRefusals?: number } | false;
  log?: RunnerLogger;
};

export type RunnerClient = {
  readonly status: RunnerClientStatus;
  readonly runnerId: string | null;
  /** Resolves with the first successful registration; rejects when the client gives up. */
  registered(): Promise<RunnerRegisterResult>;
  /** Sends one heartbeat now. */
  heartbeat(): void;
  onStatus(handler: (status: RunnerClientStatus) => void): () => void;
  close(): Promise<void>;
};

const OPEN = 1;

function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

export function runnerSocketUrl(apiUrl: string): string {
  const url = new URL("/api/runner", apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** The data socket for a stream token (spec §7.6 /api/runner/stream/{stream_token}). */
export function runnerStreamUrl(apiUrl: string, token: string): string {
  const url = new URL(`/api/runner/stream/${encodeURIComponent(token)}`, apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

type SocketCtor = new (url: string, options: { headers: Record<string, string> }) => WebSocket;
type RunnerStreamHandle = ReturnType<typeof streamOverSocket>;

export function measureLoad(): RunnerNotificationParams<"runner.heartbeat">["load"] {
  const cores = Math.max(1, cpus().length);
  const oneMinute = loadavg()[0] ?? 0;
  return {
    cpu: Math.max(0, oneMinute / cores),
    memoryMb: Math.max(0, Math.round((totalmem() - freemem()) / 1_048_576)),
  };
}

export function connectRunner(options: RunnerClientOptions): RunnerClient {
  const log: RunnerLogger = options.log ?? (() => {});
  const kind = options.kind ?? "hosted";
  const notifier = createNotifier();
  // Streams: a second socket per token, with the same connect token as the bearer.
  const openStreamSocket = (token: string): Promise<RunnerStreamHandle> =>
    new Promise((resolve, reject) => {
      const Ctor = WebSocket as unknown as SocketCtor;
      const ws = new Ctor(runnerStreamUrl(options.apiUrl, token), {
        headers: { authorization: `Bearer ${options.token}` },
      });
      const stream = streamOverSocket(ws);
      ws.addEventListener("open", () => resolve(stream), { once: true });
      ws.addEventListener("error", () => reject(new Error("stream socket failed")), { once: true });
      ws.addEventListener("close", () => reject(new Error("stream socket closed")), { once: true });
    });
  const services: RunnerServices | null = options.handlers
    ? null
    : createServices({
        ...options.handlerOptions,
        // The cli-harness lane is personal: only a runner someone connected from their own machine.
        sessions: {
          cliHarness: { allowed: kind !== "hosted" },
          ...options.handlerOptions?.sessions,
        },
        notify: notifier.emit,
        streams: { open: openStreamSocket },
      });
  const handlers: RunnerHandlers = options.handlers ?? services?.handlers ?? {};
  const reachableAt = previewHostOf(kind, options.previewHost);
  const info: RunnerInfo = {
    name: options.name ?? hostname(),
    kind,
    capabilities: options.capabilities ?? localCapabilities(),
    versions: { bun: Bun.version, ...options.versions },
    // Previews (task 1.18): a hosted runner shares a network with the api, so it says where it is.
    // A laptop does not, and saying so would only send the api somewhere it cannot go — that lane
    // is the tunnel of task 1.19.
    ...(reachableAt ? { preview_host: reachableAt } : {}),
  };
  const reconnect = options.reconnect === undefined ? {} : options.reconnect;
  const minMs = reconnect === false ? 0 : (reconnect.minMs ?? 1_000);
  const maxMs = reconnect === false ? 0 : (reconnect.maxMs ?? 30_000);
  const maxRefusals = reconnect === false ? 1 : (reconnect.maxRefusals ?? 3);
  const url = runnerSocketUrl(options.apiUrl);

  let status: RunnerClientStatus = "connecting";
  let runnerId: string | null = null;
  let socket: WebSocket | null = null;
  let capSecret = "";
  let heartbeatTimer: Timer | null = null;
  let reconnectTimer: Timer | null = null;
  let closedByUs = false;
  let refusals = 0;
  let attempt = 0;
  const sessions: string[] = [];
  let ownerUserId = options.ownerUserId;
  const statusHandlers = new Set<(status: RunnerClientStatus) => void>();
  let firstRegistration: {
    resolve: (r: RunnerRegisterResult) => void;
    reject: (e: Error) => void;
  } | null = null;
  const registeredOnce = new Promise<RunnerRegisterResult>((resolve, reject) => {
    firstRegistration = { resolve, reject };
  });
  registeredOnce.catch(() => {});
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let seq = 0;

  function setStatus(next: RunnerClientStatus): void {
    if (status === next) return;
    status = next;
    for (const handler of statusHandlers) handler(next);
  }

  function send(message: JsonRpcMessage): void {
    if (socket?.readyState === OPEN) socket.send(JSON.stringify(message));
  }

  // Handler-originated notifications (fs.changed) and the ports watcher go out on the socket.
  notifier.subscribe((notification) =>
    send({ jsonrpc: "2.0", method: notification.method, params: notification.params }),
  );
  let stopPorts: (() => void) | null = null;

  function request(method: RunnerToApiMethod, params: unknown): Promise<unknown> {
    const id = `${++seq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function heartbeat(): void {
    send({
      jsonrpc: "2.0",
      method: "runner.heartbeat",
      params: { load: measureLoad(), sessions },
    });
  }

  function stopTimers(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function giveUp(error: Error): void {
    stopTimers();
    setStatus("closed");
    firstRegistration?.reject(error);
    firstRegistration = null;
    for (const [id, entry] of pending) {
      entry.reject(error);
      pending.delete(id);
    }
  }

  async function register(): Promise<void> {
    setStatus("registering");
    const raw = await request("runner.register", info);
    const result = runnerRegisterResultSchema.parse(raw);
    runnerId = result.runner_id;
    capSecret = result.cap_secret;
    ownerUserId = options.ownerUserId ?? result.owner_user_id ?? undefined;
    attempt = 0;
    refusals = 0;
    setStatus("online");
    heartbeat();
    heartbeatTimer = setInterval(heartbeat, result.heartbeat_ms);
    heartbeatTimer.unref?.();
    log("info", "registered", { runnerId, heartbeatMs: result.heartbeat_ms });
    if (!stopPorts && options.portsIntervalMs !== 0) {
      stopPorts = watchPorts(notifier.emit, {
        ...(options.portsIntervalMs ? { intervalMs: options.portsIntervalMs } : {}),
      });
    }
    firstRegistration?.resolve(result);
    firstRegistration = null;
  }

  function refuse(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): void {
    send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  async function dispatch(message: JsonRpcRequest): Promise<void> {
    const method = message.method;
    if (!Object.hasOwn(apiToRunnerParams, method)) {
      refuse(message.id, JSON_RPC_ERRORS.methodNotFound, `unknown method ${method}`);
      return;
    }
    const typed = method as ApiToRunnerMethod;
    const parsed = apiToRunnerParams[typed].safeParse(message.params);
    if (!parsed.success) {
      refuse(message.id, JSON_RPC_ERRORS.invalidParams, `invalid params for ${method}`, {
        issues: parsed.error.issues,
      });
      return;
    }
    const params = parsed.data;
    const verdict = await verifyCap(capSecret, params.cap, {
      ws: params.workspace_id,
      user: params.user_id,
      method,
    });
    if (!verdict.ok) {
      refuse(message.id, JSON_RPC_ERRORS.unauthorized, "capability token refused", {
        reason: verdict.reason,
      });
      return;
    }
    if (kind !== "hosted" && ownerUserId && params.user_id !== ownerUserId) {
      if (!params.grant) {
        refuse(
          message.id,
          JSON_RPC_ERRORS.forbidden,
          "this runner serves its owner only; a grant is required for other users",
        );
        return;
      }
    }
    const handler = handlers[typed] as ((p: typeof params) => Promise<unknown>) | undefined;
    if (!handler) {
      refuse(
        message.id,
        JSON_RPC_ERRORS.methodNotFound,
        `${method} is not available on this runner yet`,
      );
      return;
    }
    try {
      const result = await handler(params);
      send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log("error", "handler failed", { method, error: err.message });
      refuse(message.id, errorCode(err, JSON_RPC_ERRORS.internal), err.message);
    }
  }

  function settle(response: JsonRpcResponse): void {
    if (response.id === null) return;
    const entry = pending.get(String(response.id));
    if (!entry) return;
    pending.delete(String(response.id));
    if (response.error) {
      entry.reject(
        Object.assign(new Error(response.error.message), {
          code: response.error.code,
          data: response.error.data,
        }),
      );
    } else entry.resolve(response.result);
  }

  function onMessage(text: string): void {
    let message: JsonRpcMessage;
    try {
      message = jsonRpcMessageSchema.parse(JSON.parse(text));
    } catch {
      log("warn", "invalid JSON-RPC message from the api");
      return;
    }
    if ("method" in message) {
      if ("id" in message) {
        dispatch(message).catch((error: unknown) =>
          log("error", "dispatch failed", { error: String(error) }),
        );
      }
      // The api sends no notifications today.
      return;
    }
    settle(message);
  }

  function scheduleReconnect(reason: string): void {
    if (closedByUs) return;
    if (reconnect === false) {
      giveUp(new Error(`runner connection lost: ${reason}`));
      return;
    }
    attempt += 1;
    const delay = jitter(Math.min(maxMs, minMs * 2 ** Math.min(attempt - 1, 10)));
    setStatus("reconnecting");
    log("warn", "reconnecting", { reason, attempt, delayMs: delay });
    reconnectTimer = setTimeout(open, delay);
  }

  function open(): void {
    if (closedByUs) return;
    reconnectTimer = null;
    let opened = false;
    // Bun accepts headers in the constructor options (not part of the WHATWG signature).
    const Ctor = WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const ws = new Ctor(url, { headers: { authorization: `Bearer ${options.token}` } });
    socket = ws;
    ws.onopen = () => {
      opened = true;
      register().catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        log("error", "registration refused", { error: err.message });
        // A refused registration is final: the token belongs to another kind of runner, or the
        // capabilities are not what the api accepts. Retrying would not change the answer.
        closedByUs = true;
        ws.close(1000, "registration refused");
        giveUp(err);
      });
    };
    ws.onmessage = (event) => {
      onMessage(typeof event.data === "string" ? event.data : "");
    };
    ws.onerror = () => {
      // The close event that follows carries the outcome.
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      for (const [id, entry] of pending) {
        entry.reject(new Error("connection closed"));
        pending.delete(id);
      }
      if (closedByUs) {
        setStatus("closed");
        return;
      }
      if (!opened) {
        refusals += 1;
        if (refusals >= maxRefusals) {
          giveUp(
            new Error(
              `the api refused the connection ${refusals} time(s) (${event.code}${event.reason ? `: ${event.reason}` : ""}); check the connect token`,
            ),
          );
          return;
        }
      }
      scheduleReconnect(event.reason || `code ${event.code}`);
    };
  }

  open();

  return {
    get status() {
      return status;
    },
    get runnerId() {
      return runnerId;
    },
    registered: () => registeredOnce,
    heartbeat,
    onStatus(handler) {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
    async close() {
      closedByUs = true;
      stopTimers();
      stopPorts?.();
      stopPorts = null;
      services?.close();
      const ws = socket;
      if (ws && ws.readyState <= OPEN) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          ws.addEventListener("close", done, { once: true });
          ws.close(1000, "runner shutting down");
          setTimeout(done, 1_000);
        });
      }
      setStatus("closed");
      firstRegistration?.reject(new Error("closed before registering"));
      firstRegistration = null;
    },
  };
}
