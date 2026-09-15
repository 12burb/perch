/**
 * Sessions (spec §3.3, §5.1; task 1.8, ADR-0074): the api opens a session on an engine, sends
 * turns, persists every EngineEvent to session_events with a monotonic seq, and republishes each
 * one on the bus (topic session:<id>; the milestones also reach ws:<workspace>). One round runs per
 * session at a time; a permission request parks the round in needs_you until someone answers; an
 * engine that goes silent mid-round is cancelled after `silenceMs`.
 */
import type { Bus } from "@perch/bus";
import type { CodingSession, CodingSessionKind, Db, Project, SessionCheckpoint } from "@perch/db";
import { type Engine, EngineError, type EngineRegistry } from "@perch/engines";
import {
  type FileDiff,
  gitApplyResultSchema,
  gitDiffResultSchema,
  type ModelRef,
  type PermissionAnswer,
  parseHunks,
  type RunnerLink,
  RunnerRpcError,
  type SessionEvent,
  type SessionMode,
  type SessionStatus,
  selectHunks,
  sessionCheckpointResultSchema,
  sessionRestoreResultSchema,
  type UserTurn,
} from "@perch/events";
import { proposedCode } from "@perch/events/code-blocks";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import type { Flags } from "../flags.ts";
import {
  addCost,
  appendEvent,
  copyCheckpoints,
  copyEvents,
  findInlineSession,
  getCheckpoint,
  getSession,
  insertSession,
  listCheckpoints,
  listEvents,
  listSessions,
  updateSession,
  upsertCheckpoint,
} from "../repos/sessions.ts";
import type { RunnerRegistry } from "../runners/registry.ts";
import type { BrainsService } from "./brains.ts";
import { getProject, projectRunnerLink } from "./projects.ts";
import { runnerCall, runnerError } from "./runners.ts";

export type SessionDeps = {
  db: Db;
  bus: Bus;
  registry: RunnerRegistry;
  engines: EngineRegistry;
  flags: Flags;
  /** Model profiles and the credentials behind them (task 1.15). */
  brains: BrainsService;
  log: Logger;
};

export type SessionServiceOptions = {
  /** A round with no event for this long is cancelled (default 10 minutes); a waiting permission does not count. */
  silenceMs?: number;
  /** An inline edit (task 1.14) waits this long for the agent (default 60 s); a person is waiting. */
  inlineMs?: number;
};

/** "Whatever the engine uses" until model profiles (brains, task 1.15) pick one. */
export const ENGINE_DEFAULT_MODEL: ModelRef = { provider: "engine", modelId: "default" };

/** One answer on one hunk of the diff under review (task 1.13). */
export type DiffDecision = {
  path: string;
  /** 0-based hunk index within the file's patch. */
  hunk: number;
  /** The hunk's `@@` header as the client saw it; a mismatch means the diff moved on (409). */
  header?: string;
  action: "accept" | "reject";
};

export type SessionDiff = {
  /** The turn reviewed, or null for the whole session. */
  turn: number | null;
  /** The checkpoint the diff starts from and the one it ends at (null: the working tree now). */
  fromTurn: number;
  toTurn: number | null;
  files: FileDiff[];
};

export type CreateSessionInput = {
  project: Project;
  userId: string;
  engine?: string;
  /** Which program the engine runs: an ACP agent id, a CLI id (ADR-0081). The runner's default otherwise. */
  agent?: string;
  model?: ModelRef;
  mode?: SessionMode;
  title?: string | null;
  /** agent (the default) or the editor's inline lane. */
  kind?: CodingSessionKind;
  /** The brain to run on (task 1.15); without one, the workspace's default for code, then the engine's own. */
  modelProfileId?: string;
  by: ActorContext;
};

/** What ⌘K asks for (task 1.14): an instruction about one selection in one file. */
export type InlineEditInput = {
  project: Project;
  userId: string;
  path: string;
  selection: string;
  instruction: string;
  language?: string;
  /** Overrides the engine the lane opens on; without it the runner's engines decide. */
  engine?: string;
  by: ActorContext;
};

/**
 * The turn an inline edit sends. The first line is a marker so an engine (and the tests' agent)
 * can tell this apart from a person talking; the reply is meant to be the replacement and nothing
 * else, because the editor puts it straight into the buffer.
 */
export function inlineEditPrompt(input: {
  path: string;
  selection: string;
  instruction: string;
  language?: string;
}): string {
  const fence = input.language ?? "";
  return [
    "Perch inline edit.",
    `File: ${input.path}`,
    "Rewrite the selected lines as instructed. Reply with the rewritten lines only, in one fenced",
    "code block, with no explanation and no surrounding lines. Do not edit any file yourself.",
    "",
    `Instruction: ${input.instruction}`,
    "",
    "Selection:",
    `\`\`\`${fence}`,
    input.selection,
    "```",
  ].join("\n");
}

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
  private readonly inlineMs: number;

  constructor(
    private readonly deps: SessionDeps,
    options: SessionServiceOptions = {},
  ) {
    this.silenceMs = options.silenceMs ?? 10 * 60_000;
    this.inlineMs = options.inlineMs ?? 60_000;
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
    // The cli-harness lane (spec §3.3) stays behind its flag until the CLIs' terms are confirmed.
    if (engineId === "cli-harness" && !(await this.deps.flags.isOn("cli_harness"))) {
      throw PerchError.validation("engine cli-harness is behind the cli_harness feature flag", {
        engine: engineId,
        flag: "cli_harness",
      });
    }
    const link = await projectRunnerLink(this.deps, input.project, input.userId);
    const model = input.model ?? (await this.brainFor(input));
    const session = await insertSession(this.deps.db, {
      workspaceId: input.project.workspaceId,
      projectId: input.project.id,
      runnerId: UUID.test(link.id) ? link.id : null,
      userId: input.userId,
      engine: engineId,
      ...(input.agent ? { agent: input.agent } : {}),
      model,
      mode: input.mode ?? "build",
      title: input.title ?? null,
      ...(input.kind ? { kind: input.kind } : {}),
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

  /** A new title. */
  async rename(session: CodingSession, title: string | null): Promise<CodingSession> {
    return (await updateSession(this.deps.db, session.id, { title })) ?? session;
  }

  /**
   * A fork (task 1.12, ADR-0078): a new session on the same project, engine, model, and mode with
   * the transcript so far copied in, so the conversation branches from here. The engine's own
   * memory starts fresh on the fork until adapters fork natively.
   */
  async fork(session: CodingSession, userId: string, by: ActorContext): Promise<CodingSession> {
    if (this.rounds.has(session.id)) {
      throw PerchError.conflict("wait for the running round before forking");
    }
    const project = await getProject(this.deps.db, session.workspaceId, session.projectId);
    if (!project) throw PerchError.notFound("project");
    const link = await projectRunnerLink(this.deps, project, userId);
    const fork = await insertSession(this.deps.db, {
      workspaceId: session.workspaceId,
      projectId: session.projectId,
      runnerId: UUID.test(link.id) ? link.id : null,
      userId,
      engine: session.engine,
      agent: session.agent,
      model: {
        provider: session.modelProvider,
        modelId: session.modelId,
        ...(session.modelProfileId ? { profileId: session.modelProfileId } : {}),
      },
      mode: session.mode,
      title: session.title ? `${session.title} (fork)` : null,
      forkedFromId: session.id,
      turns: session.turns,
    });
    await copyEvents(this.deps.db, session.id, fork.id);
    // The checkpoints come along: same project, same commits, so the fork can restore its
    // inherited turns and its next turn checkpoints as turn N+1 (ADR-0079).
    await copyCheckpoints(this.deps.db, session.id, fork.id);
    const fresh = (await getSession(this.deps.db, fork.id)) ?? fork;
    await this.deps.bus.publish(
      "session.created",
      {
        workspaceId: fresh.workspaceId,
        sessionId: fresh.id,
        projectId: fresh.projectId,
        userId,
        engine: fresh.engine,
      },
      { ...by, topics: this.wide(fresh) },
    );
    return fresh;
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
    await this.checkpoint(session, userId, session.turns + 1, options.by);
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

  checkpoints(session: CodingSession): Promise<SessionCheckpoint[]> {
    return listCheckpoints(this.deps.db, session.id);
  }

  /**
   * The diff of one turn (its checkpoint to the next one, or to the tree as it is now) or of the
   * whole session (the first checkpoint to now). Without a checkpoint there is nothing to show.
   */
  async diff(session: CodingSession, userId: string, turn: number | null): Promise<SessionDiff> {
    const checkpoints = await listCheckpoints(this.deps.db, session.id);
    const base = turn === null ? checkpoints[0] : checkpoints.find((c) => c.turn === turn);
    if (!base) {
      if (turn === null) return { turn: null, fromTurn: 0, toTurn: null, files: [] };
      throw PerchError.notFound("checkpoint", { turn });
    }
    const next = turn === null ? undefined : checkpoints.find((c) => c.turn > turn);
    const { link } = await this.linkFor(session, userId);
    const raw = await runnerCall(link, "git.diff", {
      workspace_id: session.workspaceId,
      user_id: userId,
      project: session.projectId,
      ref: base.gitRef,
      ...(next ? { to: next.gitRef } : {}),
    });
    const result = gitDiffResultSchema.parse(raw);
    return { turn, fromTurn: base.turn, toTurn: next?.turn ?? null, files: result.patches };
  }

  /**
   * Answers on hunks: an accept is a review decision (the edit is already in the tree), a reject
   * reverse-applies that hunk on the runner. Rejects go out as one patch, so all land or none.
   */
  async applyDecisions(
    session: CodingSession,
    userId: string,
    turn: number | null,
    decisions: DiffDecision[],
    by: ActorContext,
  ): Promise<{ files: string[] }> {
    if (this.rounds.has(session.id)) {
      throw PerchError.conflict("wait for the running round before changing its diff");
    }
    const rejects = decisions.filter((d) => d.action === "reject");
    if (rejects.length === 0) return { files: [] };
    const current = await this.diff(session, userId, turn);
    const chosen = new Map<string, { patch: string; hunks: number[] }>();
    for (const decision of rejects) {
      const file = current.files.find((f) => f.path === decision.path);
      if (!file) {
        throw PerchError.conflict(`no changes in ${decision.path} any more`, {
          path: decision.path,
        });
      }
      const hunk = parseHunks(file.patch).hunks[decision.hunk];
      if (!hunk || (decision.header !== undefined && decision.header !== hunk.header)) {
        throw PerchError.conflict(`the diff of ${decision.path} changed; reload it`, {
          path: decision.path,
          hunk: decision.hunk,
        });
      }
      const entry = chosen.get(decision.path) ?? { patch: file.patch, hunks: [] };
      entry.hunks.push(decision.hunk);
      chosen.set(decision.path, entry);
    }
    const patch = [...chosen.values()].map((e) => selectHunks(e.patch, e.hunks)).join("");
    const { link } = await this.linkFor(session, userId);
    const raw = await runnerCall(link, "git.apply", {
      workspace_id: session.workspaceId,
      user_id: userId,
      project: session.projectId,
      patch,
      reverse: true,
    });
    const { files } = gitApplyResultSchema.parse(raw);
    await this.deps.bus.publish(
      "diff.applied",
      {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        ...(turn !== null ? { turn } : {}),
        files,
      },
      { ...by, topics: this.wide(session) },
    );
    return { files };
  }

  /** The project goes back to before `turn`; the transcript records it (spec §7.7 checkpoint.restored). */
  async restore(
    session: CodingSession,
    userId: string,
    turn: number,
    by: ActorContext,
  ): Promise<{ turn: number; gitRef: string; files: string[] }> {
    if (this.rounds.has(session.id)) {
      throw PerchError.conflict("wait for the running round before restoring");
    }
    const row = await getCheckpoint(this.deps.db, session.id, turn);
    if (!row) throw PerchError.notFound("checkpoint", { turn });
    const { link } = await this.linkFor(session, userId);
    const raw = await runnerCall(link, "session.restore", {
      workspace_id: session.workspaceId,
      user_id: userId,
      session_id: session.id,
      turn,
      project: session.projectId,
      // The commit itself: a fork's checkpoints were taken under the session it copied, so the
      // runner must not have to find them by a ref named after this session (ADR-0079).
      git_ref: row.gitRef,
    });
    const { git_ref, files } = sessionRestoreResultSchema.parse(raw);
    await this.record(session, { type: "restore", turn, gitRef: git_ref, userId }, by);
    return { turn, gitRef: git_ref, files };
  }

  /**
   * ⌘K in the editor (task 1.14): one round on this person's inline session for the project, whose
   * reply is the replacement for a selection. The agent never writes the file — the editor does,
   * once the person accepts — so a permission it asks for mid-round is refused and the round goes
   * on. An empty reply is not an error: the editor says there was nothing to put there.
   */
  async inlineEdit(input: InlineEditInput): Promise<{ replacement: string; sessionId: string }> {
    const session = await this.inlineSession(input);
    if (this.rounds.has(session.id)) {
      throw PerchError.conflict("an inline edit is already running on this project");
    }
    let engine: Engine;
    try {
      engine = await this.engineFor(session, input.userId);
    } catch (error) {
      const failure = engineFailure(error);
      await this.setStatus(session, "error", failure.message, input.by);
      throw failure;
    }
    const prompt = inlineEditPrompt(input);
    await this.record(
      session,
      { type: "turn", text: prompt, mode: session.mode, userId: input.userId },
      input.by,
    );
    await updateSession(this.deps.db, session.id, { turns: session.turns + 1 });
    const running = await this.setStatus(session, "running", null, input.by);
    const round: Round = { engine, timer: null, cancelled: false };
    this.rounds.set(session.id, round);
    let text = "";
    try {
      this.armInline(running, round);
      for await (const event of engine.send(session.id, { text: prompt }, { mode: running.mode })) {
        await this.record(running, event);
        if (event.type === "text") text += event.delta;
        else if (event.type === "permission") {
          // Nobody is watching this round, and the edit belongs in the buffer, not on disk.
          await engine.respondPermission(session.id, event.id, "deny");
        } else if (event.type === "usage" && event.costUsd > 0) {
          await addCost(this.deps.db, session.id, event.costUsd);
        } else if (event.type === "done") {
          break;
        } else if (event.type === "error") {
          throw new PerchError("upstream_failed", event.message);
        }
        this.armInline(running, round);
      }
      if (round.cancelled) {
        throw new PerchError("upstream_failed", "the agent did not answer in time");
      }
    } catch (error) {
      // The runner reconnected and forgot the session. The inline lane is long-lived, so without
      // this it would stay broken forever; the next ⌘K re-opens it, as a pane round does.
      if (error instanceof EngineError && error.code === "unknown_session") {
        this.known.delete(session.id);
      }
      const failure = error instanceof PerchError ? error : engineFailure(error);
      await this.record(running, { type: "error", message: failure.message }, input.by);
      await this.setStatus(running, "error", failure.message, input.by);
      throw failure;
    } finally {
      if (round.timer) clearTimeout(round.timer);
      this.rounds.delete(session.id);
    }
    await this.setStatus(running, "idle", null, input.by);
    return { replacement: proposedCode(text), sessionId: session.id };
  }

  /** The project's inline session for this person, opened the first time ⌘K is used. */
  private async inlineSession(input: InlineEditInput): Promise<CodingSession> {
    const existing = await findInlineSession(this.deps.db, input.project.id, input.userId);
    if (existing) return existing;
    return this.create({
      project: input.project,
      userId: input.userId,
      kind: "inline",
      title: "Inline edits",
      ...(input.engine ? { engine: input.engine } : { engine: await this.inlineEngine(input) }),
      by: input.by,
    });
  }

  /**
   * ⌘K has no engine picker, so the inline lane opens on one the project's runner actually has:
   * the project's default when the runner reports it (or reports none), else the first it does.
   */
  private async inlineEngine(input: InlineEditInput): Promise<string> {
    const fallback = input.project.defaultEngine;
    try {
      const link = await projectRunnerLink(this.deps, input.project, input.userId);
      const engines = link.info.capabilities.engines;
      if (!Array.isArray(engines) || engines.length === 0) return fallback;
      const available = engines.filter((id): id is string => typeof id === "string");
      if (available.includes(fallback)) return fallback;
      return available.find((id) => this.deps.engines.has(id)) ?? fallback;
    } catch {
      // The runner is not there; create() will say so in the language of the api.
      return fallback;
    }
  }

  /** A person is waiting on an inline round, so a quiet agent is cancelled sooner than a chat one. */
  private armInline(session: CodingSession, round: Round): void {
    if (round.timer) clearTimeout(round.timer);
    round.timer = setTimeout(() => {
      round.cancelled = true;
      this.deps.log.warn({ sessionId: session.id }, "inline edit went silent; cancelling");
      void round.engine.cancel(session.id).catch(() => {});
    }, this.inlineMs);
    round.timer.unref?.();
  }

  close(): void {
    for (const round of this.rounds.values()) if (round.timer) clearTimeout(round.timer);
  }

  private wide(session: CodingSession): string[] {
    // An inline session carries someone's selection through its turns, so it stays off the
    // workspace topic: the editor is the only audience (ADR-0080).
    return session.kind === "inline"
      ? [`session:${session.id}`]
      : [`session:${session.id}`, `ws:${session.workspaceId}`];
  }

  /**
   * Which brain a new session runs on (task 1.15): the profile the caller named, else the
   * workspace's default for code, else whatever the engine is configured with.
   */
  private async brainFor(input: CreateSessionInput): Promise<ModelRef> {
    const workspaceId = input.project.workspaceId;
    const named = input.modelProfileId
      ? await this.deps.brains.profileFor(workspaceId, input.modelProfileId)
      : null;
    if (input.modelProfileId && !named) throw PerchError.notFound("model profile");
    const profile = named ?? (await this.deps.brains.defaultFor(workspaceId, "code"));
    if (!profile) return ENGINE_DEFAULT_MODEL;
    return { provider: profile.provider, modelId: profile.modelId, profileId: profile.id };
  }

  /** `{env}` for the engine when the session runs on a brain with a credential; `{}` otherwise. */
  private async engineEnv(
    session: CodingSession,
    userId: string,
  ): Promise<{ env?: Record<string, string> }> {
    if (!session.modelProfileId) return {};
    const profile = await this.deps.brains.profileFor(session.workspaceId, session.modelProfileId);
    if (!profile) return {};
    const env = await this.deps.brains.engineEnv(profile, userId);
    return Object.keys(env).length > 0 ? { env } : {};
  }

  private async linkFor(
    session: CodingSession,
    userId: string,
  ): Promise<{ project: Project; link: RunnerLink }> {
    const project = await getProject(this.deps.db, session.workspaceId, session.projectId);
    if (!project) throw PerchError.notFound("project");
    return { project, link: await projectRunnerLink(this.deps, project, userId) };
  }

  /**
   * Before a turn runs: the working tree as it is, so the turn has a diff and a restore point
   * (task 1.13). Best effort: a project that is not a repository still takes turns.
   */
  private async checkpoint(
    session: CodingSession,
    userId: string,
    turn: number,
    by: ActorContext,
  ): Promise<void> {
    try {
      const { link } = await this.linkFor(session, userId);
      const raw = await runnerCall(link, "session.checkpoint", {
        workspace_id: session.workspaceId,
        user_id: userId,
        session_id: session.id,
        turn,
        project: session.projectId,
      });
      const { git_ref } = sessionCheckpointResultSchema.parse(raw);
      await upsertCheckpoint(this.deps.db, { sessionId: session.id, turn, gitRef: git_ref });
      await this.deps.bus.publish(
        "checkpoint.created",
        { workspaceId: session.workspaceId, sessionId: session.id, turn, gitRef: git_ref },
        { ...by, topics: this.wide(session) },
      );
    } catch (error) {
      this.deps.log.warn({ err: error, sessionId: session.id, turn }, "checkpoint skipped");
    }
  }

  private async engineFor(session: CodingSession, userId: string): Promise<Engine> {
    const { link } = await this.linkFor(session, userId);
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
          ...(session.agent ? { agent: session.agent } : {}),
          model: {
            provider: session.modelProvider,
            modelId: session.modelId,
            ...(session.modelProfileId ? { profileId: session.modelProfileId } : {}),
          },
          mode: session.mode,
          // The credential goes into the engine's environment and nowhere else (AGENTS.md §1.6).
          ...(await this.engineEnv(session, userId)),
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
      case "restore":
        await bus.publish(
          "checkpoint.restored",
          {
            workspaceId: session.workspaceId,
            sessionId: session.id,
            turn: event.turn,
            gitRef: event.gitRef,
          },
          wide,
        );
        break;
    }
    return stored;
  }
}
