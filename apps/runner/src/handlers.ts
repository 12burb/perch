/**
 * The §7.6 methods a runner answers, keyed by method. Phase 1 fills this table task by task (fs, git,
 * pty, sessions, ports, previews, exec); until then a method is "not available on this runner yet".
 */
import type { ApiToRunnerMethod, RunnerRequestParams } from "@perch/events";

export type RunnerHandler<M extends ApiToRunnerMethod> = (
  params: RunnerRequestParams<M>,
) => Promise<unknown>;

export type RunnerHandlers = { [M in ApiToRunnerMethod]?: RunnerHandler<M> };

/** What every runner answers today: the listening-port list (empty until task 1.5 discovers ports). */
export function defaultHandlers(): RunnerHandlers {
  return {
    "ports.list": async () => ({ ports: [] }),
  };
}

export function implementedMethods(handlers: RunnerHandlers): ApiToRunnerMethod[] {
  return (Object.keys(handlers) as ApiToRunnerMethod[]).filter((m) => handlers[m] !== undefined);
}
