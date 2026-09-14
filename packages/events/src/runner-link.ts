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

export interface RunnerLink {
  /** Stable per connection; hosted runners use the runner row id, local ones the connect token id. */
  readonly id: string;
  readonly info: RunnerInfo;
  /** Sends an api→runner request; rejects with a RunnerRpcError on a JSON-RPC error. */
  call<M extends ApiToRunnerMethod>(method: M, params: RunnerCallParams<M>): Promise<unknown>;
  /** Runner→api notifications (heartbeats, port changes, session events, …). */
  onNotification(handler: (notification: RunnerNotification) => void): () => void;
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
