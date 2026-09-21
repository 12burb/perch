/**
 * A runner as the api sees it, independent of transport (spec §7.6): the hosted and local runners
 * speak JSON-RPC over a WebSocket; laptop mode attaches an in-process runner through the same
 * interface. Requests are api→runner methods; notifications are runner→api methods.
 */
import type { z } from "zod";
import type {
  ApiToRunnerMethod,
  apiToRunnerParams,
  RunnerToApiMethod,
  runnerToApiParams,
} from "./runner-rpc.ts";

export type RunnerInfo = z.infer<(typeof runnerToApiParams)["runner.register"]>;
export type RunnerRequestParams<M extends ApiToRunnerMethod> = z.infer<
  (typeof apiToRunnerParams)[M]
>;
/** What a caller passes to `RunnerLink.call`: the link mints the capability token itself. */
export type RunnerCallParams<M extends ApiToRunnerMethod> = Omit<RunnerRequestParams<M>, "cap">;
export type RunnerNotificationParams<M extends RunnerToApiMethod> = z.infer<
  (typeof runnerToApiParams)[M]
>;

export type RunnerNotification = {
  [M in RunnerToApiMethod]: { method: M; params: RunnerNotificationParams<M> };
}[RunnerToApiMethod];

/**
 * A data stream beside the control channel (spec §7.6 "data streams as extra sockets at
 * /api/runner/stream/{stream_token}"): text frames both ways, closed by either side. A PTY's output
 * and input travel here; the in-process runner pairs two ends in memory.
 */
export interface RunnerStream {
  send(data: string): void;
  onMessage(handler: (data: string) => void): () => void;
  onClose(handler: () => void): () => void;
  close(): void;
  readonly closed: boolean;
}

/**
 * How long the api waits for one answer (ADR-0163). Unset means the link's default, which is
 * sized for a short call; a clone, a check run or an exec with a budget of its own says so here.
 */
export type RunnerCallOptions = { timeoutMs?: number };

export interface RunnerLink {
  /** Stable per connection; hosted runners use the runner row id, local ones the connect token id. */
  readonly id: string;
  readonly info: RunnerInfo;
  /** Sends an api→runner request; rejects with a RunnerRpcError on a JSON-RPC error. */
  call<M extends ApiToRunnerMethod>(
    method: M,
    params: RunnerCallParams<M>,
    options?: RunnerCallOptions,
  ): Promise<unknown>;
  /** Runner→api notifications (heartbeats, port changes, session events, …). */
  onNotification(handler: (notification: RunnerNotification) => void): () => void;
  /** The stream a method answered with a stream token opens (task 1.7); absent before then. */
  openStream?(token: string): Promise<RunnerStream>;
  close(): Promise<void>;
}

export class RunnerRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RunnerRpcError";
    this.code = code;
    this.data = data;
  }
}
