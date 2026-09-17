/**
 * Sessions (spec §3.3, §5.1; task 1.8, ADR-0074): the api opens a session on an engine, sends
 * turns, persists every EngineEvent to session_events with a monotonic seq, and republishes each
 * one on the bus (topic session:<id>; the milestones also reach ws:<workspace>). One round runs per
 * session at a time; a permission request parks the round in needs_you until someone answers; an
 * engine that goes silent mid-round is cancelled after `silenceMs`.
 */

import { context, type Span, trace } from "@opentelemetry/api";
import type { Bus } from "@perch/bus";
import type {
  CodingSession,
  CodingSessionKind,
  Db,
  Project,
  SessionCheckpoint,
  SessionReasoning,
  Workspace,
} from "@perch/db";
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
  type SessionMcpServer,
  type SessionMode,
  type SessionStatus,
  selectHunks,
  sessionCheckpointResultSchema,
  sessionRestoreResultSchema,
  type UserTurn,
  worktreeCreateResultSchema,
  worktreeRemoveResultSchema,
} from "@perch/events";
import { proposedCode } from "@perch/events/code-blocks";
import { type Redaction, redactDeep } from "@perch/policy";
import type { Vault } from "@perch/vault";
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
import { findWorkspaceById } from "../repos/workspaces.ts";
import type { RunnerRegistry } from "../runners/registry.ts";
import { ids, tracer } from "../telemetry/tracing.ts";
import type { BrainsService } from "./brains.ts";
import type { McpGateway } from "./mcp.ts";
import { envFor, secretsOf } from "./project-env.ts";
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
  /** The MCP gateway (task 1.17): what a session may reach, and the tokens it reaches with. */
  mcp: McpGateway;
  /** Where a project's own environment is sealed (task 2.13). */
  vault: Vault;
  /**
   * What is running in this workspace, so a session can be given eyes on it (task 3.21), and the
   * command that does the looking. Both absent means an agent works blind, as it did before.
   */
  previews?: {
    ports: (workspace: Workspace, project: Project) => { runnerId: string; configured: boolean }[];
  };
  playwrightMcp?: string | undefined;
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
  /** How hard to think (task 2.18); `auto` — the agent's own choice — otherwise. */
  reasoning?: SessionReasoning;
  /** The chat this session answers in, when an agent bot opened it from one (task 3.7). */
  channelId?: string | undefined;
  threadRootId?: string | null | undefined;
  botId?: string | undefined;
  /** The work item this session is doing, when the board started it (task 3.13). */
  workItemId?: string | undefined;
  /**
   * Nobody is waiting at a keyboard for this one, so it settles when its round goes quiet rather
   * than holding a runner open (ADR-0133). A session started from a work item is unattended
   * whether or not it says so; a race entrant says so (task 3.16).
   */
  unattended?: boolean | undefined;
  /**
   * Work in a git worktree of this name rather than in the project checkout (spec §6
   * `coding_sessions.worktree`; task 3.14). The branch is made from the project's default branch
   * if it is not already there, and two sessions on two worktrees never see each other's files.
   */
  worktree?: string | undefined;
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
/**
 * What a commit message draft asks for (task 1.20). The first line is the same marker the inline
 * lane's other prompts use, so an engine (and the tests' agent) can tell it from a person talking,
 * and the answer is meant to be the message and nothing else.
 */
export function commitMessagePrompt(diff: string): string {
  const trimmed = diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n… (diff truncated)` : diff;
  return [
    "Perch commit message",
    "Write the commit message for this diff. A conventional-commit subject under 72 characters,",
    "then a blank line, then a short body only if the diff needs one. No fences, no preamble.",
    "",
    "```diff",
    trimmed,
    "```",
  ].join("\n");
}

/** The agent's answer as a commit message: no fences, no preamble line, a bounded subject. */
export function cleanCommitMessage(text: string): string {
  const fenced = /```[^\n]*\n([\s\S]*?)\n?```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const lines = body.split("\n");
  const first = (lines[0] ?? "").trim();
  // An agent that opens with "Here is the commit message:" gets that line dropped.
  const start = /message:?$/i.test(first) && lines.length > 1 ? 1 : 0;
  const kept = lines
    .slice(start)
    .join("\n")
    .trim()
    .replace(/\n{3,}/g, "\n\n");
  const [subject = "", ...rest] = kept.split("\n");
  const capped = subject.length > 100 ? `${subject.slice(0, 99)}…` : subject;
  return [capped, ...rest].join("\n").trim();
}

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
  /** The second timer: the one that ends a round its engine could not even be told to stop. */
  giveUp: Timer | null;
  cancelled: boolean;
};

type PendingPermission = { id: string; tool: string; seq: number };

/**
 * How long a cancelled round is given to end itself before the session service ends it (task 4.10).
 * A healthy engine answers a cancel in milliseconds; this is the window for one whose runner is
 * gone, where nothing is ever going to answer.
 */
const GIVE_UP_MS = 5_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a tool may run with nobody watching (task 2.18, ADR-0111). A name matches literally or
 * through one trailing `*`; the list is the project's own `.perch/project.json`, so this is the
 * repository saying what it trusts, not Perch deciding for it. The policy engine still applies to
 * whatever the tool then does.
 */
export function unattended(names: readonly string[] | undefined, tool: string): boolean {
  if (!names || names.length === 0) return false;
  const want = tool.trim().toLowerCase();
  if (!want) return false;
  return names.some((raw) => {
    const name = raw.trim().toLowerCase();
    if (!name) return false;
    if (name === "*") return true;
    return name.endsWith("*") ? want.startsWith(name.slice(0, -1)) : want === name;
  });
}

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

/**
 * One engine event, as trace (task 3.22). A tool call opens a span and its result closes it, so
 * what a trace shows is the tool's own duration rather than the round's; usage lands on the round,
 * which is where "what did this cost" is asked.
 */
function traceEvent(round: Span, tools: Map<string, Span>, event: SessionEvent): void {
  if (event.type === "tool_call") {
    // Hung off the round explicitly rather than off the active context: the context only carries
    // the round where a context manager is installed, and a tool beside its round says nothing.
    const under = trace.setSpan(context.active(), round);
    tools.set(
      event.id,
      tracer().startSpan(`tool.${event.name}`, { attributes: { "perch.tool": event.name } }, under),
    );
    return;
  }
  if (event.type === "tool_result") {
    const open = tools.get(event.id);
    if (!open) return;
    if (event.diff?.length) open.setAttribute("perch.files_changed", event.diff.length);
    open.end();
    tools.delete(event.id);
    return;
  }
  if (event.type === "permission") {
    round.addEvent("permission", { "perch.tool": event.tool });
    return;
  }
  if (event.type === "usage") {
    round.setAttributes({
      "perch.input_tokens": event.input,
      "perch.output_tokens": event.output,
      "perch.cost_usd": event.costUsd,
    });
    return;
  }
  if (event.type === "error") round.addEvent("error", { "perch.message": event.message });
}

/**
 * What a round's end may hand back (task 3.18): `true` means something is about to send another
 * turn, so the session should stay open instead of settling.
 */
export type RoundEndHook = (session: CodingSession) => Promise<boolean>;

export class SessionService {
  private readonly rounds = new Map<string, Round>();
  /** Set by the testing loop at boot (task 3.18); nothing happens between rounds without it. */
  private roundEnd: RoundEndHook | null = null;
  private readonly pending = new Map<string, PendingPermission>();
  /** Sessions this process has opened on their engine (engines forget across api restarts). */
  private readonly known = new Set<string>();
  /** What must not turn up in each session's transcript (task 2.13). */
  private readonly secrets = new Map<string, Redaction[]>();
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
    // A worktree of its own, before the row exists: a session that cannot get one has not started
    // (task 3.14). A project that is not a repository has none to give, and says so.
    const worktree = input.worktree
      ? await this.worktree(link, input.project, input.userId, input.worktree)
      : null;
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
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      title: input.title ?? null,
      ...(input.kind ? { kind: input.kind } : {}),
      // Where its cards go, when a mention in a chat is what opened it (task 3.7).
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
      ...(input.botId ? { botId: input.botId } : {}),
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      unattended: input.unattended ?? input.workItemId !== undefined,
      ...(worktree ? { worktree: worktree.branch, branch: worktree.branch } : {}),
    });
    await this.grantConnections(session);
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

  /**
   * A session a bot opened over the Bot API (spec §7.3 `sessions.open`; task 2.19). It runs as the
   * bot's owner — a bot is not a person and has no runner of its own — and says so in the actor, so
   * the audit log records which bot asked.
   */
  async openForBot(
    bot: { id: string; ownerId: string },
    project: Project,
    input: { engine?: string; prompt?: string },
  ): Promise<{ id: string; status: string }> {
    const by: ActorContext = { actor: { type: "bot", id: bot.id }, meta: {} };
    const session = await this.create({
      project,
      userId: bot.ownerId,
      ...(input.engine ? { engine: input.engine } : {}),
      title: `Opened by a bot`,
      by,
    });
    if (!input.prompt) return { id: session.id, status: session.status };
    try {
      const sent = await this.sendTurn(session, bot.ownerId, { text: input.prompt }, { by });
      return { id: sent.session.id, status: sent.session.status };
    } catch (error) {
      if (!(error instanceof PerchError)) throw error;
      const fresh = await this.get(session.id);
      return { id: session.id, status: fresh?.status ?? "error" };
    }
  }

  /** A new title. */
  async rename(session: CodingSession, title: string | null): Promise<CodingSession> {
    return (await updateSession(this.deps.db, session.id, { title })) ?? session;
  }

  /** How hard this session thinks from the next round on (task 2.18). */
  async setReasoning(session: CodingSession, reasoning: SessionReasoning): Promise<CodingSession> {
    return (await updateSession(this.deps.db, session.id, { reasoning })) ?? session;
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
    await this.grantConnections(fresh);
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

  /**
   * Starts a round: the turn is recorded, the engine answers in the background.
   *
   * `options.context` is material the engine should read before the turn — today the `@codebase`
   * block (task 2.17, ADR-0110). It never reaches the transcript: what a person sees themselves
   * having said is what they typed.
   *
   * `options.reasoning` is how hard to think for this round (task 2.18); without one the session's
   * own level stands.
   */
  async sendTurn(
    session: CodingSession,
    userId: string,
    turn: UserTurn,
    options: {
      mode?: SessionMode;
      by: ActorContext;
      context?: string;
      reasoning?: SessionReasoning;
    },
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
    const round: Round = { engine, timer: null, giveUp: null, cancelled: false };
    this.rounds.set(session.id, round);
    const input: UserTurn = options.context
      ? { ...turn, text: `${options.context}\n\n${turn.text}` }
      : turn;
    const reasoning = options.reasoning ?? session.reasoning;
    void this.runRound(session, round, input, mode, reasoning).catch((error: unknown) => {
      this.deps.log.error({ err: error, sessionId: session.id }, "session round crashed");
    });
    return { seq, session: updated };
  }

  /**
   * What runs when a round goes quiet, before auto-settle decides (task 3.18). It answers whether
   * something is going to send another turn — the testing loop, when the project's tests failed
   * and the agent has attempts left — because a session that has already ended cannot be told
   * anything.
   */
  onRoundEnd(hook: RoundEndHook): void {
    this.roundEnd = hook;
  }

  /** Stop and ask a person, with the reason on the row where the inbox and the card read it. */
  async park(session: CodingSession, why: string): Promise<CodingSession> {
    return this.setStatus(session, "needs_you", why);
  }

  /** End a session nothing is going to send another turn to (task 3.18's failure path). */
  async settle(session: CodingSession): Promise<void> {
    const fresh = await getSession(this.deps.db, session.id);
    if (fresh?.status === "idle") await this.setStatus(fresh, "ended");
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
    const { text, sessionId } = await this.inlineRound(input, inlineEditPrompt(input));
    return { replacement: proposedCode(text), sessionId };
  }

  /**
   * A commit message drafted from a diff (spec §5.1 "AI commit message"; task 1.20). The same lane
   * as ⌘K: one prompt, one answer, nobody watching — so it never opens a session pane and never
   * asks for a permission.
   */
  async commitMessage(input: {
    project: Project;
    userId: string;
    diff: string;
    engine?: string;
    by: ActorContext;
  }): Promise<{ message: string; sessionId: string }> {
    const { text, sessionId } = await this.inlineRound(input, commitMessagePrompt(input.diff));
    return { message: cleanCommitMessage(text), sessionId };
  }

  /** One round on the project's inline session: the prompt in, the agent's whole answer out. */
  private async inlineRound(
    input: { project: Project; userId: string; engine?: string; by: ActorContext },
    prompt: string,
  ): Promise<{ text: string; sessionId: string }> {
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
    await this.record(
      session,
      { type: "turn", text: prompt, mode: session.mode, userId: input.userId },
      input.by,
    );
    await updateSession(this.deps.db, session.id, { turns: session.turns + 1 });
    const running = await this.setStatus(session, "running", null, input.by);
    const round: Round = { engine, timer: null, giveUp: null, cancelled: false };
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
    return { text, sessionId: session.id };
  }

  /** The project's inline session for this person, opened the first time ⌘K is used. */
  private async inlineSession(input: {
    project: Project;
    userId: string;
    engine?: string;
    by: ActorContext;
  }): Promise<CodingSession> {
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
  private async inlineEngine(input: { project: Project; userId: string }): Promise<string> {
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
  /**
   * The MCP servers this session may reach (spec §7.5; task 1.17). A failure here costs the session
   * its tools, not its turn: an agent that cannot list a provider's issues is still an agent.
   */
  private async mcpServers(session: CodingSession): Promise<{ mcpServers?: SessionMcpServer[] }> {
    try {
      const servers = await this.deps.mcp.serversFor({
        workspaceId: session.workspaceId,
        userId: session.userId,
        sessionId: session.id,
      });
      const all = [...servers, ...(await this.eyes(session))];
      return all.length > 0 ? { mcpServers: all } : {};
    } catch (error) {
      this.deps.log.warn({ err: error, sessionId: session.id }, "mcp servers unavailable");
      return {};
    }
  }

  /**
   * The agent's eyes (spec §5.6 "@playwright/mcp in the runner attached to sessions when a preview
   * is open"; task 3.21, ADR-0139). A browser has to be where the page is, so this one is spawned
   * on the runner rather than served over HTTP.
   *
   * Only while the project's own preview is actually serving — the port `.perch/project.json`
   * names, with something on it. Any-port-is-up would be wrong twice over: a runner has other
   * things listening, and Perch would not know which of them is the page. A browser attached to a
   * session with nothing to look at is a process and a context window spent on nothing, and an
   * agent offered tools that cannot work is an agent that will try them.
   */
  private async eyes(session: CodingSession): Promise<SessionMcpServer[]> {
    const command = this.deps.playwrightMcp?.trim();
    if (!command || !this.deps.previews) return [];
    const workspace = await findWorkspaceById(this.deps.db, session.workspaceId);
    const project = await getProject(this.deps.db, session.workspaceId, session.projectId);
    if (!workspace || !project) return [];
    // A configured port that nothing is serving yet has no runner on it: that is the Start button,
    // not a page.
    const up = this.deps.previews
      .ports(workspace, project)
      .some((one) => one.configured && one.runnerId !== "");
    if (!up) return [];
    const [head, ...args] = command.split(/\s+/).filter(Boolean);
    if (!head) return [];
    return [{ name: "playwright", command: head, ...(args.length > 0 ? { args } : {}) }];
  }

  /** Grants a fresh session its owner's own connections (ADR-0083); never fatal to the session. */
  private async grantConnections(session: CodingSession): Promise<void> {
    try {
      await this.deps.mcp.grantSession({
        workspaceId: session.workspaceId,
        userId: session.userId,
        sessionId: session.id,
      });
    } catch (error) {
      this.deps.log.warn(
        { err: error, sessionId: session.id },
        "session connection grants skipped",
      );
    }
  }

  private async engineEnv(
    session: CodingSession,
    userId: string,
  ): Promise<{ env?: Record<string, string> }> {
    // The project's own environment first (spec §5.7 "injected into runner, previews, sessions"),
    // then the model's credential, which a project variable must not be able to stand in for.
    const project = await getProject(this.deps.db, session.workspaceId, session.projectId);
    const own = project ? await envFor({ db: this.deps.db, vault: this.deps.vault }, project) : {};
    const profile = session.modelProfileId
      ? await this.deps.brains.profileFor(session.workspaceId, session.modelProfileId)
      : null;
    const credential = profile ? await this.deps.brains.engineEnv(profile, userId) : {};
    const env = { ...own, ...credential };
    return Object.keys(env).length > 0 ? { env } : {};
  }

  /**
   * What must not turn up in this session's transcript (spec §5.7 "never into a model context";
   * task 2.13). Read once when the engine is made, which is before any event can arrive.
   */
  private async secretsFor(session: CodingSession): Promise<Redaction[]> {
    const found = this.secrets.get(session.id);
    if (found) return found;
    const project = await getProject(this.deps.db, session.workspaceId, session.projectId);
    const secrets = project
      ? await secretsOf({ db: this.deps.db, vault: this.deps.vault }, project)
      : [];
    this.secrets.set(session.id, secrets);
    return secrets;
  }

  /**
   * A git worktree for one session (spec §7.6 `worktree.create`; task 3.14). The runner puts it
   * beside the project at `<project>.worktrees/<branch>`, on a branch made from the default one,
   * so two agents on the same repository are editing two different directories.
   */
  private async worktree(
    link: RunnerLink,
    project: Project,
    userId: string,
    branch: string,
  ): Promise<{ path: string; branch: string }> {
    try {
      const raw = await runnerCall(link, "worktree.create", {
        workspace_id: project.workspaceId,
        user_id: userId,
        project: project.id,
        branch,
        base: project.defaultBranch,
      });
      return worktreeCreateResultSchema.parse(raw);
    } catch (error) {
      throw runnerError(error);
    }
  }

  /** Give a worktree back once nobody is working in it (task 3.14). Best effort, and quiet. */
  async dropWorktree(session: CodingSession, userId: string): Promise<boolean> {
    if (!session.worktree) return false;
    try {
      const { project, link } = await this.linkFor(session, userId);
      const raw = await runnerCall(link, "worktree.remove", {
        workspace_id: project.workspaceId,
        user_id: userId,
        project: project.id,
        branch: session.worktree,
      });
      return worktreeRemoveResultSchema.parse(raw).removed;
    } catch (error) {
      this.deps.log.warn(
        { err: error, sessionId: session.id, worktree: session.worktree },
        "a worktree could not be removed",
      );
      return false;
    }
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
    await this.secretsFor(session);
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
          // Its own checkout, when it has one (task 3.14).
          ...(session.worktree ? { worktree: session.worktree } : {}),
          // The credential goes into the engine's environment and nowhere else (AGENTS.md §1.6).
          ...(await this.engineEnv(session, userId)),
          // Tools, without tokens: each server is Perch's gateway, each bearer Perch's own.
          ...(await this.mcpServers(session)),
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
    if (round.giveUp) {
      clearTimeout(round.giveUp);
      round.giveUp = null;
    }
    round.timer = setTimeout(() => {
      round.timer = null;
      if (this.pending.has(session.id)) return;
      this.deps.log.warn({ sessionId: session.id }, "session round went silent; cancelling");
      round.cancelled = true;
      void round.engine.cancel(session.id).catch(() => {});
      // A cancel reaches the agent through its runner, so an engine whose runner has gone cannot
      // be cancelled at all: the round would iterate for ever and the session would go on telling
      // everybody it was running (task 4.10's chaos drill found exactly that). The cancel gets a
      // moment to land, and then the round is ended from this side.
      round.giveUp = setTimeout(() => {
        void this.abandon(session, round);
      }, GIVE_UP_MS);
      round.giveUp.unref?.();
    }, this.silenceMs);
    round.timer.unref?.();
  }

  /**
   * Ends a round nothing is going to end: the engine went quiet and would not be cancelled. The
   * session says what happened rather than sitting at `running`, and the next turn can start.
   */
  private async abandon(session: CodingSession, round: Round): Promise<void> {
    // It may have finished on its own while the grace ran; the round map is the arbiter.
    if (this.rounds.get(session.id) !== round) return;
    this.rounds.delete(session.id);
    this.pending.delete(session.id);
    const message = "the agent stopped answering and its runner could not be reached";
    this.deps.log.warn({ sessionId: session.id }, "session round abandoned");
    try {
      await this.record(session, { type: "error", message });
      await this.setStatus(session, "error", message);
    } catch (error) {
      this.deps.log.error({ err: error, sessionId: session.id }, "abandoning the round failed");
    }
  }

  private async runRound(
    session: CodingSession,
    round: Round,
    turn: UserTurn,
    mode: SessionMode,
    reasoning: SessionReasoning,
  ): Promise<void> {
    let ended = false;
    // The project's background policy (task 2.18, ADR-0111): which tools may run with nobody
    // watching, and whether the session lets itself go once the round is over.
    const project = await getProject(this.deps.db, session.workspaceId, session.projectId);
    const background = project?.config.background ?? {};
    const tools = new Map<string, Span>();
    // One trace per round (task 3.22): the model call is this span, and every tool it asks for
    // and every runner RPC underneath lands inside it — active, so a runner call three layers
    // down needs to know nothing about the round it is part of.
    await tracer().startActiveSpan(
      "session.round",
      {
        attributes: {
          "perch.engine": session.engine,
          "perch.turn": session.turns + 1,
          "perch.mode": mode,
          ...ids({
            workspaceId: session.workspaceId,
            projectId: session.projectId,
            sessionId: session.id,
            userId: session.userId,
            ...(session.workItemId ? { workItemId: session.workItemId } : {}),
          }),
        },
      },
      async (round_) => {
        try {
          this.armSilence(session, round);
          for await (const event of round.engine.send(session.id, turn, {
            mode,
            ...(reasoning === "auto" ? {} : { reasoning }),
          })) {
            const { seq } = await this.record(session, event);
            traceEvent(round_, tools, event);
            if (event.type === "permission") {
              if (unattended(background.unattended, event.tool)) {
                // Answered by the project's own policy, and the transcript says so rather than
                // pretending a person pressed Allow.
                await this.record(session, {
                  type: "tool_result",
                  id: event.id,
                  output: `allowed without asking: ${event.tool} is unattended in this project`,
                });
                await round.engine.respondPermission(session.id, event.id, "allow").catch(() => {});
                this.armSilence(session, round);
                continue;
              }
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
          // Auto-settle: a background run that finished with nothing waiting on a person lets its
          // session go, so a runner is not held open by a conversation nobody is having.
          //
          // An unattended session always settles (ADR-0133). A session the board opened belongs to
          // the card rather than to a person at a keyboard, and its ending is what moves the card to
          // review — a session that never ends is a card that never moves. A race entrant is the same
          // thing: its ending is what gets it measured and compared (task 3.16).
          // The project's own tests on what this round wrote, with a failure fed back as the next
          // turn (task 3.18). It answers before auto-settle, because a session that has ended cannot
          // be told anything — and only for a round that finished cleanly: an agent that errored, or
          // one parked on a permission, has a different problem from a failing test.
          let held = false;
          const after = await getSession(this.deps.db, session.id);
          if (after?.status === "idle") {
            try {
              held = (await this.roundEnd?.(after)) ?? false;
            } catch (error) {
              this.deps.log.warn(
                { err: error, sessionId: session.id },
                "the round-end hook failed",
              );
            }
          }
          const settles = background.autoSettle || session.unattended;
          if (settles && !held && !this.pending.has(session.id)) {
            const fresh = await getSession(this.deps.db, session.id);
            if (fresh?.status === "idle") await this.setStatus(fresh, "ended");
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
            this.deps.log.error(
              { err: inner, sessionId: session.id },
              "could not record the failure",
            );
          }
        } finally {
          // A tool the engine never finished is still a span that has to end.
          for (const open of tools.values()) open.end();
          round_.end();
          if (round.timer) clearTimeout(round.timer);
          if (round.giveUp) clearTimeout(round.giveUp);
          this.rounds.delete(session.id);
          this.pending.delete(session.id);
        }
      },
    );
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
    raw: SessionEvent,
    by?: ActorContext,
  ): Promise<{ seq: number; ts: Date }> {
    // A project's own secrets never land in the record: what is written says which name it was
    // (task 2.13). The engine still runs with the real values; only the transcript is cleaned.
    const event = redactDeep(raw, this.secrets.get(session.id) ?? []);
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
