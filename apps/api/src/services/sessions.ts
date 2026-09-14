/**
 * Sessions (spec §3.3, §5.1; task 1.8, ADR-0074): the api opens a session on an engine, sends
 * turns, persists every EngineEvent to session_events with a monotonic seq, and republishes each
 * one on the bus (topic session:<id>; the milestones also reach ws:<workspace>). One round runs per
 * session at a time; a permission request parks the round in needs_you until someone answers; an
 * engine that goes silent mid-round is cancelled after `silenceMs`.
 */
import type { Bus } from "@perch/bus";
import type { CodingSession, Db, Project } from "@perch/db";
import { type Engine, EngineError, type EngineRegistry } from "@perch/engines";
import {
  type ModelRef,
  type PermissionAnswer,
  RunnerRpcError,
  type SessionEvent,
  type SessionMode,
  type SessionStatus,
  type UserTurn,
} from "@perch/events";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import {
  addCost,
  appendEvent,
  getSession,
  insertSession,
  listEvents,
  listSessions,
  updateSession,
} from "../repos/sessions.ts";
import type { RunnerRegistry } from "../runners/registry.ts";
import { getProject, projectRunnerLink } from "./projects.ts";
import { runnerError } from "./runners.ts";

export type SessionDeps = {
  db: Db;
  bus: Bus;
  registry: RunnerRegistry;
  engines: EngineRegistry;
  log: Logger;
};

export type SessionServiceOptions = {
  /** A round with no event for this long is cancelled (default 10 minutes); a waiting permission does not count. */
  silenceMs?: number;
};

/** "Whatever the engine uses" until model profiles (brains, task 1.15) pick one. */
export const ENGINE_DEFAULT_MODEL: ModelRef = { provider: "engine", modelId: "default" };

export type CreateSessionInput = {
  project: Project;
  userId: string;
  engine?: string;
  model?: ModelRef;
  mode?: SessionMode;
  title?: string | null;
  by: ActorContext;
};

type Round = {
  engine: Engine;
  timer: Timer | null;
  cancelled: boolean;
};

type PendingPermission = { id: string; tool: string; seq: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An engine's refusal as the §7.8 error it means to the caller. */
export function engineFailure(error: unknown): PerchError {
  if (error instanceof PerchError) return error;
  if (error instanceof RunnerRpcError) return runnerError(error);
  if (error instanceof EngineError) {
    switch (error.code) {
      case "busy":
        return PerchError.conflict(error.message);
      case "unknown_engine":
        return PerchError.validation(error.message);
      case "unknown_session":
      case "unknown_permission":
        return PerchError.notFound(error.message);
      default:
        return new PerchError("upstream_failed", error.message);
    }
  }
  return new PerchError("upstream_failed", error instanceof Error ? error.message : String(error));
}

export class SessionService {
  private readonly rounds = new Map<string, Round>();
  private readonly pending = new Map<string, PendingPermission>();
  /** Sessions this process has opened on their engine (engines forget across api restarts). */
  private readonly known = new Set<string>();
  private readonly silenceMs: number;

  constructor(
    private readonly deps: SessionDeps,
    options: SessionServiceOptions = {},
  ) {
    this.silenceMs = options.silenceMs ?? 10 * 60_000;
  }

  get engines(): EngineRegistry {
    return this.deps.engines;
  }

  get(id: string): Promise<CodingSession | null> {
    return getSession(this.deps.db, id);
  }

  list(workspaceId: string, projectId: string): Promise<CodingSession[]> {
    return listSessions(this.deps.db, workspaceId, projectId);
  }

  /** A session's transcript after a seq (the replay endpoint and a reconnecting client). */
  async events(sessionId: string, afterSeq = 0, limit = 500) {
    const rows = await listEvents(this.deps.db, sessionId, afterSeq, limit);
    return rows.map((row) => ({ seq: row.seq, ts: row.ts, event: row.event as SessionEvent }));
  }

  /** Whether a round is running (or waiting on a permission) for the session right now. */
  running(sessionId: string): boolean {
    return this.rounds.has(sessionId);
  }

  /** The permission waiting for an answer, when one is. */
  pendingPermission(sessionId: string): PendingPermission | null {
    return this.pending.get(sessionId) ?? null;
  }

  async create(input: CreateSessionInput): Promise<CodingSession> {
    const engineId = input.engine ?? input.project.defaultEngine;
    if (!this.deps.engines.has(engineId)) {
      throw PerchError.validation(`engine ${engineId} is not available`, {
        engine: engineId,
        available: this.deps.engines.ids(),
      });
    }
    const link = await projectRunnerLink(this.deps, input.project, input.userId);
    const session = await insertSession(this.deps.db, {
      workspaceId: input.project.workspaceId,
      projectId: input.project.id,
      runnerId: UUID.test(link.id) ? link.id : null,
      userId: input.userId,
      engine: engineId,
      model: input.model ?? ENGINE_DEFAULT_MODEL,
      mode: input.mode ?? "build",
      title: input.title ?? null,
    });
    await this.deps.bus.publish(
      "session.created",
      {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        projectId: session.projectId,
        userId: session.userId,
        engine: engineId,
      },
      { ...input.by, topics: this.wide(session) },
    );
    return session;
  }

  /** Starts a round: the turn is recorded, the engine answers in the background. */
  async sendTurn(
    session: CodingSession,
    userId: string,
    turn: UserTurn,
    options: { mode?: SessionMode; by: ActorContext },
  ): Promise<{ seq: number; session: CodingSession }> {
    if (session.status === "ended") throw PerchError.conflict("the session has ended");
    if (this.rounds.has(session.id)) {
      throw PerchError.conflict("a round is already running", { status: session.status });
    }
    let engine: Engine;
    try {
      engine = await this.engineFor(session, userId);
    } catch (error) {
      // The engine could not be reached or opened: the transcript says so, and so does the caller.
      const failure = engineFailure(error);
      await this.record(session, { type: "error", message: failure.message }, options.by);
      await this.setStatus(session, "error", failure.message, options.by);
      throw failure;
    }
    const mode = options.mode ?? session.mode;
    const { seq } = await this.record(
      session,
      {
        type: "turn",
        text: turn.text,
        ...(turn.attachments ? { attachments: turn.attachments } : {}),
        mode,
        userId,
      },
      options.by,
    );
    await updateSession(this.deps.db, session.id, { turns: session.turns + 1 });
    const updated = await this.setStatus(session, "running", null, options.by);
    const round: Round = { engine, timer: null, cancelled: false };
    this.rounds.set(session.id, round);
    void this.runRound(session, round, turn, mode).catch((error: unknown) => {
      this.deps.log.error({ err: error, sessionId: session.id }, "session round crashed");
    });
    return { seq, session: updated };
  }

  async respondPermission(
    session: CodingSession,
    permissionId: string,
    answer: PermissionAnswer,
    userId: string,
    by: ActorContext,
  ): Promise<CodingSession> {
    const pending = this.pending.get(session.id);
    const round = this.rounds.get(session.id);
    if (!pending || pending.id !== permissionId || !round) throw PerchError.notFound("permission");
    // Back to running before the engine moves on, so the round's own updates always land later.
    this.pending.delete(session.id);
    const running = await this.setStatus(session, "running", null, by);
    try {
      await round.engine.respondPermission(session.id, permissionId, answer);
    } catch (error) {
      this.pending.set(session.id, pending);
      await this.setStatus(session, "needs_you", null, by);
      throw engineFailure(error);
    }
    this.armSilence(session, round);
    await this.deps.bus.publish(
      "session.permission_answered",
      { workspaceId: session.workspaceId, sessionId: session.id, permissionId, answer, userId },
      { ...by, topics: this.wide(session) },
    );
    return running;
  }

  /** Asks the engine to stop the round; the round then ends with the engine's done or error. */
  async cancel(session: CodingSession): Promise<{ cancelled: boolean }> {
    const round = this.rounds.get(session.id);
    if (!round) return { cancelled: false };
    round.cancelled = true;
    try {
      await round.engine.cancel(session.id);
    } catch (error) {
      throw engineFailure(error);
    }
    return { cancelled: true };
  }

  close(): void {
    for (const round of this.rounds.values()) if (round.timer) clearTimeout(round.timer);
  }

  private wide(session: CodingSession): string[] {
    return [`session:${session.id}`, `ws:${session.workspaceId}`];
  }

  private async engineFor(session: CodingSession, userId: string): Promise<Engine> {
    const project = await getProject(this.deps.db, session.workspaceId, session.projectId);
    if (!project) throw PerchError.notFound("project");
    const link = await projectRunnerLink(this.deps, project, userId);
    let engine: Engine;
    try {
      engine = this.deps.engines.resolve(session.engine, { link });
    } catch (error) {
      throw engineFailure(error);
    }
    if (!this.known.has(session.id)) {
      try {
        const created = await engine.createSession({
          sessionId: session.id,
          workspaceId: session.workspaceId,
          projectId: session.projectId,
          userId: session.userId,
          model: {
            provider: session.modelProvider,
            modelId: session.modelId,
            ...(session.modelProfileId ? { profileId: session.modelProfileId } : {}),
          },
          mode: session.mode,
        });
        if (created.engineSessionId && created.engineSessionId !== session.engineSessionId) {
          await updateSession(this.deps.db, session.id, {
            engineSessionId: created.engineSessionId,
          });
        }
      } catch (error) {
        throw engineFailure(error);
      }
      this.known.add(session.id);
    }
    return engine;
  }

  private armSilence(session: CodingSession, round: Round): void {
    if (round.timer) clearTimeout(round.timer);
    round.timer = setTimeout(() => {
      round.timer = null;
      if (this.pending.has(session.id)) return;
      this.deps.log.warn({ sessionId: session.id }, "session round went silent; cancelling");
      round.cancelled = true;
      void round.engine.cancel(session.id).catch(() => {});
    }, this.silenceMs);
    round.timer.unref?.();
  }

  private async runRound(
    session: CodingSession,
    round: Round,
    turn: UserTurn,
    mode: SessionMode,
  ): Promise<void> {
    let ended = false;
    try {
      this.armSilence(session, round);
      for await (const event of round.engine.send(session.id, turn, { mode })) {
        const { seq } = await this.record(session, event);
        if (event.type === "permission") {
          this.pending.set(session.id, { id: event.id, tool: event.tool, seq });
          if (round.timer) clearTimeout(round.timer);
          round.timer = null;
          await this.setStatus(session, "needs_you");
          continue;
        }
        this.armSilence(session, round);
        if (event.type === "usage" && event.costUsd > 0) {
          await addCost(this.deps.db, session.id, event.costUsd);
        } else if (event.type === "done") {
          ended = true;
          await this.setStatus(session, "idle");
          break;
        } else if (event.type === "error") {
          ended = true;
          await this.setStatus(session, "error", event.message);
          break;
        }
      }
      if (!ended) {
        await this.record(session, { type: "done" });
        await this.setStatus(session, "idle");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.warn({ err: error, sessionId: session.id }, "session round failed");
      if (error instanceof EngineError && error.code === "unknown_session") {
        this.known.delete(session.id);
      }
      try {
        await this.record(session, { type: "error", message });
        await this.setStatus(session, "error", message);
      } catch (inner) {
        this.deps.log.error({ err: inner, sessionId: session.id }, "could not record the failure");
      }
    } finally {
      if (round.timer) clearTimeout(round.timer);
      this.rounds.delete(session.id);
      this.pending.delete(session.id);
    }
  }

  private async setStatus(
    session: CodingSession,
    status: SessionStatus,
    message: string | null = null,
    by?: ActorContext,
  ): Promise<CodingSession> {
    const updated = await updateSession(this.deps.db, session.id, {
      status,
      statusMessage: message,
      ...(status === "ended" ? { endedAt: new Date() } : {}),
    });
    await this.deps.bus.publish(
      "session.status",
      { workspaceId: session.workspaceId, sessionId: session.id, status },
      { ...(by ?? {}), topics: this.wide(session) },
    );
    return updated ?? session;
  }

  /** Persists an event at the next seq and republishes it (spec §3.3). */
  private async record(
    session: CodingSession,
    event: SessionEvent,
    by?: ActorContext,
  ): Promise<{ seq: number; ts: Date }> {
    const stored = await appendEvent(this.deps.db, session.id, event);
    const base = { workspaceId: session.workspaceId, sessionId: session.id, seq: stored.seq };
    const wide = { ...(by ?? {}), topics: this.wide(session) };
    const narrow = { ...(by ?? {}), topics: [`session:${session.id}`] };
    const bus = this.deps.bus;
    switch (event.type) {
      case "turn":
        await bus.publish(
          "session.turn",
          { ...base, userId: event.userId, preview: event.text.slice(0, 200) },
          wide,
        );
        break;
      case "text":
        await bus.publish("session.delta", { ...base, delta: event.delta }, narrow);
        break;
      case "tool_call":
        await bus.publish(
          "session.tool_call",
          { ...base, callId: event.id, name: event.name },
          narrow,
        );
        break;
      case "tool_result":
        await bus.publish(
          "session.tool_result",
          {
            ...base,
            callId: event.id,
            ...(event.diff ? { changedFiles: event.diff.map((d) => d.path) } : {}),
          },
          narrow,
        );
        break;
      case "permission":
        await bus.publish(
          "session.permission_requested",
          { ...base, permissionId: event.id, tool: event.tool },
          wide,
        );
        break;
      case "usage":
        await bus.publish(
          "session.usage",
          { ...base, inputTokens: event.input, outputTokens: event.output, costUsd: event.costUsd },
          narrow,
        );
        break;
      case "done":
        await bus.publish("session.done", base, wide);
        break;
      case "error":
        await bus.publish("session.error", { ...base, message: event.message }, wide);
        break;
    }
    return stored;
  }
}
