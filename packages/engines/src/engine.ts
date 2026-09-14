/**
 * The Engine interface (spec §3.3): what every adapter implements (acp, opencode, cli-harness,
 * native, hermes) and what the api's session service drives. An engine answers a turn with an
 * AsyncIterable of EngineEvents; the api persists each one to session_events with a monotonic seq
 * and republishes it on session:<id> (task 1.8, ADR-0074).
 */
import type { EngineEvent, ModelRef, PermissionAnswer, SessionMode, UserTurn } from "@perch/events";

export type EngineCapabilities = {
  code: boolean;
  tools: boolean;
  subagents: boolean;
  streaming: boolean;
};

export type CreateSessionParams = {
  /** The api's session id (coding_sessions.id); engines key their state by it. */
  sessionId: string;
  workspaceId: string;
  projectId?: string;
  userId: string;
  model: ModelRef;
  systemPrompt?: string;
  mode: SessionMode;
  /** The worktree the session runs in, when it has one of its own (spec §5.7). */
  worktree?: string;
  /** Project environment for the engine's process (never a Perch credential). */
  env?: Record<string, string>;
};

export type EngineSession = {
  id: string;
  /** The engine's own id for the session (an ACP session id, an OpenCode session id). */
  engineSessionId?: string;
};

export type SendOptions = { mode?: SessionMode };

export interface Engine {
  /** acp, opencode, cli-harness, native, hermes, cli, native-code, or a test engine's name. */
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  createSession(params: CreateSessionParams): Promise<EngineSession>;
  /** One round: the events end with `done` or `error`. */
  send(sessionId: string, input: UserTurn, options?: SendOptions): AsyncIterable<EngineEvent>;
  respondPermission(
    sessionId: string,
    permissionId: string,
    answer: PermissionAnswer,
  ): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  /** Forget a session's state once the api ended it. */
  close?(sessionId: string): Promise<void>;
}

export type EngineErrorCode =
  | "unknown_engine"
  | "unknown_session"
  | "unknown_permission"
  | "busy"
  | "unavailable";

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: EngineErrorCode = "unavailable",
  ) {
    super(message);
    this.name = "EngineError";
  }
}
