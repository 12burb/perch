/**
 * The in-process runner (spec §3.1 PERCH_RUNNER_MODE=inprocess, task 0.14): laptop mode attaches this
 * RunnerLink directly to the api instead of opening /api/runner. It registers, heartbeats, and answers
 * every method the default handlers implement (projects, fs, git, ports, exec); PTY, sessions, the
 * preview tunnel, and MCP spawning are refused with "method not found" until their tasks land
 * (ADR-0059).
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
} from "@perch/events";
import { localCapabilities } from "./capabilities.ts";
import {
  defaultHandlers,
  errorCode,
  type HandlerOptions,
  implementedMethods,
  type RunnerHandlers,
} from "./handlers.ts";
import { watchPorts } from "./ports.ts";

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
  const methods: RunnerHandlers = defaultHandlers({
    ...(options.projectsDir ? { projects: { root: options.projectsDir } } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
    notify: emit,
  });
  const capabilities = localCapabilities();
  const info: RunnerInfo = {
    name: options.name ?? `${hostname()} (in-process)`,
    kind: "local",
    capabilities,
    versions: { bun: Bun.version, runner: "0.0.0", ...options.versions },
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
        throw new RunnerRpcError(
          -32601,
          `${method} is not available on the in-process runner yet`,
          {
            arrives: "Phase 1 (tasks 1.4–1.21)",
          },
        );
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
    async close() {
      if (timer) clearInterval(timer);
      stopPorts?.();
      handlers.clear();
    },
  };
}
