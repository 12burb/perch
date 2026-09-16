/**
 * The in-process runner (spec §3.1 PERCH_RUNNER_MODE=inprocess, task 0.14): laptop mode attaches this
 * RunnerLink directly to the api instead of opening /api/runner. It registers, heartbeats, and answers
 * every method the default handlers implement, which since task 3.24 is all of §7.6: projects, fs,
 * git, ports, exec, PTY, sessions, the preview tunnel, and MCP spawning. Anything outside the
 * protocol is still refused with "method not found" (ADR-0059).
 */
import { hostname } from "node:os";
import type { RunnerCapabilities } from "@perch/db";
import {
  type ApiToRunnerMethod,
  apiToRunnerParams,
  type RunnerCallParams,
  type RunnerInfo,
  type RunnerLink,
  type RunnerNotification,
  RunnerRpcError,
  type RunnerStream,
} from "@perch/events";
import { localCapabilities } from "./capabilities.ts";
import {
  createServices,
  defaultHandlers,
  errorCode,
  type HandlerOptions,
  implementedMethods,
  type RunnerHandlers,
} from "./handlers.ts";
import { watchPorts } from "./ports.ts";
import { createStreamPair } from "./streams.ts";

export const IMPLEMENTED_METHODS: ReadonlySet<ApiToRunnerMethod> = new Set<ApiToRunnerMethod>(
  implementedMethods(defaultHandlers()),
);

export type InProcessRunnerOptions = {
  id?: string;
  name?: string;
  /** Heartbeat period; 0 disables the timer (tests call `heartbeat()` directly). */
  heartbeatMs?: number;
  versions?: Record<string, string>;
  /** Where projects live (laptop mode: <data dir>/projects). */
  projectsDir?: string;
  /** The policy hook (default: the built-in rules). */
  policy?: HandlerOptions["policy"];
  /** ports.changed polling period; 0 disables the watcher (tests). */
  portsIntervalMs?: number;
  /** Shell options (tmux, grace period); laptop mode keeps the defaults. */
  pty?: HandlerOptions["pty"];
  /** Session options (ACP agents, the default agent); laptop mode keeps the defaults. */
  sessions?: HandlerOptions["sessions"];
};

export type InProcessRunner = RunnerLink & {
  /** Emits one heartbeat now. */
  heartbeat(): void;
  readonly capabilities: RunnerCapabilities;
};

export function createInProcessRunner(options: InProcessRunnerOptions = {}): InProcessRunner {
  const handlers = new Set<(notification: RunnerNotification) => void>();
  const emit = (notification: RunnerNotification) => {
    for (const handler of handlers) handler(notification);
  };
  // Streams never leave the process: the runner side gets one end of a pair, the api the other.
  const streams = new Map<string, RunnerStream>();
  const services = createServices({
    ...(options.projectsDir ? { projects: { root: options.projectsDir } } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.pty ? { pty: options.pty } : {}),
    // Laptop mode runs on the person's own machine: the cli-harness lane is allowed.
    sessions: { cliHarness: { allowed: true }, ...options.sessions },
    notify: emit,
    streams: {
      open: async (token) => {
        const pair = createStreamPair();
        streams.set(token, pair.a);
        return pair.b;
      },
    },
  });
  const methods: RunnerHandlers = services.handlers;
  const capabilities = localCapabilities();
  const info: RunnerInfo = {
    name: options.name ?? `${hostname()} (in-process)`,
    kind: "local",
    capabilities,
    versions: { bun: Bun.version, runner: "0.0.0", ...options.versions },
    // The api is this process, so a preview is a loopback connection away (task 1.18).
    preview_host: "127.0.0.1",
  };
  const heartbeat = () => {
    const usage = process.memoryUsage();
    emit({
      method: "runner.heartbeat",
      params: { load: { memoryMb: Math.round(usage.rss / 1_048_576) }, sessions: [] },
    });
  };
  const period = options.heartbeatMs ?? 15_000;
  const timer = period > 0 ? setInterval(heartbeat, period) : null;
  timer?.unref?.();
  const stopPorts =
    options.portsIntervalMs === 0
      ? null
      : watchPorts(emit, options.portsIntervalMs ? { intervalMs: options.portsIntervalMs } : {});

  return {
    id: options.id ?? `inprocess:${Bun.randomUUIDv7()}`,
    info,
    capabilities,
    heartbeat,
    async call<M extends ApiToRunnerMethod>(method: M, params: RunnerCallParams<M>) {
      if (!(method in apiToRunnerParams)) {
        throw new RunnerRpcError(-32601, `unknown method ${String(method)}`);
      }
      // No socket, no capability token: the api and this runner are one process.
      const parsed = apiToRunnerParams[method].parse({ ...params, cap: "inprocess" });
      const handler = methods[method] as ((p: typeof parsed) => Promise<unknown>) | undefined;
      if (!handler) {
        throw new RunnerRpcError(-32601, `${method} is not available on the in-process runner`);
      }
      try {
        return await handler(parsed);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new RunnerRpcError(errorCode(err, -32603), err.message);
      }
    },
    onNotification(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async openStream(token) {
      // pty.open registers the pair before it answers, so the end is there by the time this runs.
      const stream = streams.get(token);
      if (!stream) throw new RunnerRpcError(-32602, `unknown stream token ${token}`);
      streams.delete(token);
      return stream;
    },
    async close() {
      if (timer) clearInterval(timer);
      stopPorts?.();
      services.close();
      handlers.clear();
    },
  };
}
