/**
 * Sessions on a runner (spec §7.6 session.create/send/permission/cancel; task 1.9, ADR-0075): the
 * runner side of every engine hosted here. Today the ACP adapter (any registry agent); OpenCode's
 * extras and the cli-harness arrive with their tasks. A round's events go to the api as
 * session.event notifications; session.send answers as soon as the round started.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  JSON_RPC_ERRORS,
  type RunnerRequestParams,
  RunnerRpcError,
  type SessionCreateResult,
} from "@perch/events";
import {
  ACP_AGENTS,
  type AcpAgentSpec,
  AcpSession,
  agentTable,
  describeError,
  resolveAgentLaunch,
} from "./acp.ts";
import type { Notify } from "./notify.ts";
import type { RunnerPolicy } from "./policy.ts";
import { projectDir } from "./projects.ts";
import { shellEnv } from "./pty.ts";

export type SessionsOptions = {
  root: string;
  policy: RunnerPolicy;
  notify?: Notify;
  /** Hosted homes (/data/homes/<user>): an agent runs with the person's HOME. */
  homes?: string;
  /** The ACP agents this runner may launch (default: the registry table plus PERCH_ACP_AGENTS). */
  agents?: Record<string, AcpAgentSpec>;
  /** The agent for sessions whose model names none (default: PERCH_ACP_AGENT, else gemini). */
  defaultAgent?: string;
  /** Sessions with no round for this long are closed (default 30 min). */
  idleMs?: number;
  log?: (line: string) => void;
};

type Live = {
  params: RunnerRequestParams<"session.create">;
  acp: AcpSession;
  lastUsed: number;
};

export class SessionManager {
  private readonly sessions = new Map<string, Live>();
  private readonly agents: Record<string, AcpAgentSpec>;
  private readonly defaultAgent: string;
  private readonly reaper: Timer;

  constructor(private readonly options: SessionsOptions) {
    this.agents = options.agents ?? agentTable();
    this.defaultAgent = options.defaultAgent ?? process.env.PERCH_ACP_AGENT ?? "gemini";
    const idleMs = options.idleMs ?? 30 * 60_000;
    this.reaper = setInterval(
      () => {
        const cutoff = Date.now() - idleMs;
        for (const [id, live] of this.sessions) {
          if (live.lastUsed < cutoff && !live.acp.busy) void this.close(id);
        }
      },
      Math.max(1_000, idleMs / 2),
    );
    this.reaper.unref?.();
  }

  /** The agents this runner can launch right now (binary on PATH or npx available). */
  availableAgents(): string[] {
    return Object.entries(this.agents)
      .filter(([, spec]) => resolveAgentLaunch(spec) !== null)
      .map(([id]) => id);
  }

  async create(params: RunnerRequestParams<"session.create">): Promise<SessionCreateResult> {
    if (params.engine !== "acp") {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.invalidParams,
        `engine ${params.engine} is not available on this runner (acp is)`,
      );
    }
    if (this.sessions.has(params.session_id)) {
      throw new RunnerRpcError(JSON_RPC_ERRORS.invalidParams, "the session is already open here");
    }
    const provider = params.model.provider;
    const agentId = provider === "engine" || provider === "default" ? this.defaultAgent : provider;
    const spec = this.agents[agentId];
    if (!spec) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.invalidParams,
        `unknown ACP agent ${agentId} (known: ${Object.keys(this.agents).join(", ")})`,
      );
    }
    const launch = resolveAgentLaunch(spec);
    if (!launch) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.internal,
        `${spec.name} is not installed on this runner (needs ${spec.command ?? spec.npx?.package ?? "a command"} on PATH${spec.npx ? " or npx" : ""})`,
      );
    }
    const dir = projectDir(this.options.root, params.workspace_id, params.project);
    const cwd = params.worktree ? join(`${dir}.worktrees`, params.worktree) : dir;
    if (!existsSync(cwd)) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.invalidParams,
        params.worktree
          ? `worktree ${params.worktree} does not exist`
          : "the project is not on this runner",
      );
    }
    const env = {
      ...shellEnv(
        this.options.homes ? { homes: this.options.homes } : {},
        params.user_id,
        process.env,
      ),
      ...(spec.env ?? {}),
      ...(params.env ?? {}),
    };
    const sessionId = params.session_id;
    const emit = (event: Parameters<typeof this.emitEvent>[1]) => this.emitEvent(sessionId, event);
    const acp = await AcpSession.open({
      sessionId,
      projectId: params.project,
      cwd,
      launch,
      env,
      mode: params.mode,
      policy: this.options.policy,
      emit,
      ...(this.options.notify ? { notify: this.options.notify } : {}),
      onStderr: (line) => this.options.log?.(`[${agentId} ${sessionId.slice(0, 8)}] ${line}`),
    });
    this.sessions.set(sessionId, { params, acp, lastUsed: Date.now() });
    return {
      ...(acp.agentSessionId ? { engine_session_id: acp.agentSessionId } : {}),
      agent: { id: agentId, name: spec.name },
      ...(acp.modes ? { modes: acp.modes } : {}),
    };
  }

  private emitEvent(sessionId: string, event: Parameters<AcpSession["options"]["emit"]>[0]): void {
    this.options.notify?.({ method: "session.event", params: { session_id: sessionId, event } });
  }

  private live(sessionId: string): Live {
    const live = this.sessions.get(sessionId);
    if (!live) {
      throw new RunnerRpcError(JSON_RPC_ERRORS.invalidParams, `unknown session ${sessionId}`);
    }
    return live;
  }

  /** Starts a round; its events arrive as notifications, ending with done or error. */
  async send(params: RunnerRequestParams<"session.send">): Promise<{ started: boolean }> {
    const live = this.live(params.session_id);
    if (live.acp.busy) {
      throw new RunnerRpcError(JSON_RPC_ERRORS.internal, "a round is already running");
    }
    live.lastUsed = Date.now();
    void live.acp
      .runTurn(params.turn.text, params.mode)
      .catch((error: unknown) => {
        this.emitEvent(params.session_id, { type: "error", message: describeError(error) });
      })
      .finally(() => {
        live.lastUsed = Date.now();
      });
    return { started: true };
  }

  async permission(
    params: RunnerRequestParams<"session.permission">,
  ): Promise<{ answered: boolean }> {
    const live = this.live(params.session_id);
    if (!live.acp.answerPermission(params.permission_id, params.answer)) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.invalidParams,
        `no permission ${params.permission_id} is waiting`,
      );
    }
    return { answered: true };
  }

  async cancel(params: RunnerRequestParams<"session.cancel">): Promise<{ cancelled: boolean }> {
    const live = this.live(params.session_id);
    return { cancelled: await live.acp.cancel() };
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async close(sessionId: string): Promise<boolean> {
    const live = this.sessions.get(sessionId);
    if (!live) return false;
    this.sessions.delete(sessionId);
    await live.acp.close();
    return true;
  }

  async closeAll(): Promise<void> {
    clearInterval(this.reaper);
    for (const id of [...this.sessions.keys()]) await this.close(id);
  }
}

export { ACP_AGENTS };
