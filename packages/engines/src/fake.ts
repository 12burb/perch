/**
 * A scripted engine for tests and demos (task 1.8): each round answers with the events a script
 * returns (by default an echo of the turn, a usage line, and done); a `permission` event pauses
 * the round until respondPermission answers it; cancel ends the round with done.
 */
import type { EngineEvent, PermissionAnswer, SessionMode, UserTurn } from "@perch/events";
import {
  type CreateSessionParams,
  type Engine,
  type EngineCapabilities,
  EngineError,
  type EngineSession,
  type SendOptions,
} from "./engine.ts";

export type FakeTurnContext = {
  sessionId: string;
  round: number;
  mode: SessionMode;
  params: CreateSessionParams;
};
/** What the fake answers a turn with; the round ends at the first done or error, or after the last event. */
export type FakeScript = (turn: UserTurn, context: FakeTurnContext) => EngineEvent[];

export type FakeEngineOptions = {
  id?: string;
  script?: FakeScript;
  /** A pause before each event (ms), so a caller can observe a round in flight. */
  delayMs?: number;
  capabilities?: Partial<EngineCapabilities>;
};

type FakeSession = {
  params: CreateSessionParams;
  round: number;
  running: boolean;
  cancelled: boolean;
  waiting: { id: string; resolve: (answer: PermissionAnswer) => void } | null;
  answers: { id: string; answer: PermissionAnswer }[];
};

/** The default script: the turn echoed word by word, a usage line, done. */
export function echoScript(turn: UserTurn, context: FakeTurnContext): EngineEvent[] {
  const words = `Echo (${context.mode}): ${turn.text}`.split(" ");
  return [
    ...words.map((word, i): EngineEvent => ({ type: "text", delta: i === 0 ? word : ` ${word}` })),
    { type: "usage", input: turn.text.length, output: words.length, costUsd: 0 },
    { type: "done" },
  ];
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FakeEngine implements Engine {
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  private readonly sessions = new Map<string, FakeSession>();

  constructor(private readonly options: FakeEngineOptions = {}) {
    this.id = options.id ?? "fake";
    this.capabilities = {
      code: true,
      tools: true,
      subagents: false,
      streaming: true,
      ...options.capabilities,
    };
  }

  async createSession(params: CreateSessionParams): Promise<EngineSession> {
    this.sessions.set(params.sessionId, {
      params,
      round: 0,
      running: false,
      cancelled: false,
      waiting: null,
      answers: [],
    });
    return { id: params.sessionId, engineSessionId: `fake-${params.sessionId.slice(0, 8)}` };
  }

  private session(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new EngineError(`unknown session ${sessionId}`, "unknown_session");
    return session;
  }

  /** The answers a session's permissions got, in order (tests). */
  answers(sessionId: string): { id: string; answer: PermissionAnswer }[] {
    return [...this.session(sessionId).answers];
  }

  /** How many rounds a session ran (tests). */
  rounds(sessionId: string): number {
    return this.session(sessionId).round;
  }

  async *send(
    sessionId: string,
    input: UserTurn,
    options?: SendOptions,
  ): AsyncIterable<EngineEvent> {
    const session = this.session(sessionId);
    if (session.running) throw new EngineError("a round is already running", "busy");
    session.running = true;
    session.cancelled = false;
    session.round += 1;
    const mode = options?.mode ?? session.params.mode;
    try {
      const script = this.options.script ?? echoScript;
      const events = script(input, {
        sessionId,
        round: session.round,
        mode,
        params: session.params,
      });
      for (const event of events) {
        if (session.cancelled) {
          yield { type: "done" };
          return;
        }
        if (this.options.delayMs) await pause(this.options.delayMs);
        if (event.type === "permission") {
          yield event;
          const answer = await new Promise<PermissionAnswer>((resolve) => {
            session.waiting = { id: event.id, resolve };
          });
          session.waiting = null;
          session.answers.push({ id: event.id, answer });
          continue;
        }
        yield event;
        if (event.type === "done" || event.type === "error") return;
      }
      yield { type: "done" };
    } finally {
      session.running = false;
      session.waiting = null;
    }
  }

  async respondPermission(
    sessionId: string,
    permissionId: string,
    answer: PermissionAnswer,
  ): Promise<void> {
    const session = this.session(sessionId);
    if (!session.waiting || session.waiting.id !== permissionId) {
      throw new EngineError(`no permission ${permissionId} is waiting`, "unknown_permission");
    }
    session.waiting.resolve(answer);
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.session(sessionId);
    session.cancelled = true;
    session.waiting?.resolve("deny");
  }

  async close(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
