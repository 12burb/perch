/**
 * Sessions on a runner (spec §7.6 session.create/send/permission/cancel; tasks 1.9 and 1.10,
 * ADR-0075, ADR-0076): the runner side of every engine hosted here: the ACP adapter (any registry
 * agent) and the OpenCode adapter (`opencode serve` per project); the cli-harness arrives with
 * task 1.11. A round's events go to the api as session.event notifications; session.send answers
 * as soon as the round started.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type EngineEvent,
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
import { OpenCodeHost, type OpenCodeOptions } from "./opencode.ts";
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
  /** OpenCode: the binary, or a running server for tests. */
  opencode?: OpenCodeOptions;
  log?: (line: string) => void;
};

/** What every hosted engine's session answers to the manager. */
export interface HostedSession {
  readonly busy: boolean;
  readonly engineSessionId: string | null;
  runTurn(text: string, mode?: RunnerRequestParams<"session.send">["mode"]): Promise<void>;
  answerPermission(
    permissionId: string,
    answer: RunnerRequestParams<"session.permission">["answer"],
  ): boolean | Promise<boolean>;
  cancel(): Promise<boolean>;
  close(): Promise<void>;
}

type Live = {
  params: RunnerRequestParams<"session.create">;
  session: HostedSession;
  lastUsed: number;
};

export class SessionManager {
  private readonly sessions = new Map<string, Live>();
  private readonly agents: Record<string, AcpAgentSpec>;
  private readonly defaultAgent: string;
  private readonly opencode: OpenCodeHost;
  private readonly reaper: Timer;

  constructor(private readonly options: SessionsOptions) {
    this.agents = options.agents ?? agentTable();
    this.defaultAgent = options.defaultAgent ?? process.env.PERCH_ACP_AGENT ?? "gemini";
    this.opencode = new OpenCodeHost({
      ...(options.opencode ?? {}),
      ...(options.log ? { log: (line: string) => options.log?.(`[opencode] ${line}`) } : {}),
    });
    const idleMs = options.idleMs ?? 30 * 60_000;
    this.reaper = setInterval(
      () => {
        const cutoff = Date.now() - idleMs;
        for (const [id, live] of this.sessions) {
          if (live.lastUsed < cutoff && !live.session.busy) void this.close(id);
        }
        this.opencode.reap(idleMs);
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

  /** The engines this runner hosts: acp always, opencode when its binary (or server) is there. */
  engines(): string[] {
    return ["acp", ...(this.opencode.available() ? ["opencode"] : [])];
  }

  async create(params: RunnerRequestParams<"session.create">): Promise<SessionCreateResult> {
    if (this.sessions.has(params.session_id)) {
      throw new RunnerRpcError(JSON_RPC_ERRORS.invalidParams, "the session is already open here");
    }
    if (params.engine === "opencode") return this.createOpenCode(params);
    if (params.engine !== "acp") {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.invalidParams,
        `engine ${params.engine} is not available on this runner (${this.engines().join(", ")})`,
      );
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
    const cwd = this.cwdOf(params);
    const env = { ...this.envOf(params), ...(spec.env ?? {}) };
    const sessionId = params.session_id;
    const acp = await AcpSession.open({
      sessionId,
      projectId: params.project,
      cwd,
      launch,
      env,
      mode: params.mode,
      policy: this.options.policy,
      emit: (event) => this.emitEvent(sessionId, event),
      ...(this.options.notify ? { notify: this.options.notify } : {}),
      onStderr: (line) => this.options.log?.(`[${agentId} ${sessionId.slice(0, 8)}] ${line}`),
    });
    this.sessions.set(sessionId, {
      params,
      session: {
        get busy() {
          return acp.busy;
        },
        engineSessionId: acp.agentSessionId,
        runTurn: (text, mode) => acp.runTurn(text, mode),
        answerPermission: (id, answer) => acp.answerPermission(id, answer),
        cancel: () => acp.cancel(),
        close: () => acp.close(),
      },
      lastUsed: Date.now(),
    });
    return {
      ...(acp.agentSessionId ? { engine_session_id: acp.agentSessionId } : {}),
      agent: { id: agentId, name: spec.name },
      ...(acp.modes ? { modes: acp.modes } : {}),
    };
  }

  private async createOpenCode(
    params: RunnerRequestParams<"session.create">,
  ): Promise<SessionCreateResult> {
    if (!this.opencode.available()) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.internal,
        "OpenCode is not installed on this runner (needs opencode on PATH)",
      );
    }
    const cwd = this.cwdOf(params);
    const env = this.envOf(params);
    const sessionId = params.session_id;
    const provider = params.model.provider;
    const model =
      provider === "engine" || provider === "default"
        ? undefined
        : { providerID: provider, modelID: params.model.modelId };
    let session: HostedSession & { engineSessionId: string };
    try {
      session = await this.opencode.open({
        sessionId,
        cwd,
        env,
        mode: params.mode,
        ...(model ? { model } : {}),
        emit: (event) => this.emitEvent(sessionId, event),
      });
    } catch (error) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.internal,
        error instanceof Error ? error.message : String(error),
      );
    }
    this.sessions.set(sessionId, { params, session, lastUsed: Date.now() });
    return {
      engine_session_id: session.engineSessionId,
      agent: { id: "opencode", name: "OpenCode" },
      modes: {
        current: params.mode,
        available: [
          { id: "build", name: "Build" },
          { id: "plan", name: "Plan" },
        ],
      },
    };
  }

  private cwdOf(params: RunnerRequestParams<"session.create">): string {
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
    return cwd;
  }

  private envOf(params: RunnerRequestParams<"session.create">): Record<string, string> {
    return {
      ...shellEnv(
        this.options.homes ? { homes: this.options.homes } : {},
        params.user_id,
        process.env,
      ),
      ...(params.env ?? {}),
    };
  }

  private emitEvent(sessionId: string, event: EngineEvent): void {
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
    if (live.session.busy) {
      throw new RunnerRpcError(JSON_RPC_ERRORS.internal, "a round is already running");
    }
    live.lastUsed = Date.now();
    void live.session
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
    if (!(await live.session.answerPermission(params.permission_id, params.answer))) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.invalidParams,
        `no permission ${params.permission_id} is waiting`,
      );
    }
    return { answered: true };
  }

  async cancel(params: RunnerRequestParams<"session.cancel">): Promise<{ cancelled: boolean }> {
    const live = this.live(params.session_id);
    return { cancelled: await live.session.cancel() };
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async close(sessionId: string): Promise<boolean> {
    const live = this.sessions.get(sessionId);
    if (!live) return false;
    this.sessions.delete(sessionId);
    await live.session.close();
    return true;
  }

  async closeAll(): Promise<void> {
    clearInterval(this.reaper);
    for (const id of [...this.sessions.keys()]) await this.close(id);
    this.opencode.closeAll();
  }
}

export { ACP_AGENTS };
