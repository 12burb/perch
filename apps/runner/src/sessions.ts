/**
 * Sessions on a runner (spec §7.6 session.create/send/permission/cancel; tasks 1.9 and 1.10,
 * ADR-0075, ADR-0076): the runner side of every engine hosted here: the ACP adapter (any registry
 * agent) and the OpenCode adapter (`opencode serve` per project); the cli-harness arrives with
 * task 1.11. A round's events go to the api as session.event notifications; session.send answers
 * as soon as the round started.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  type EngineEvent,
  JSON_RPC_ERRORS,
  type RunnerRequestParams,
  RunnerRpcError,
  type SessionCreateResult,
  type SessionMcpServer,
} from "@perch/events";
import {
  ACP_AGENTS,
  type AcpAgentSpec,
  AcpSession,
  type AcpSessionOptions,
  type AgentLaunch,
  agentTable,
  describeError,
  resolveAgentLaunch,
} from "./acp.ts";
import { CLI_HARNESS, CliHarnessSession, type CliHarnessSpec } from "./cli-harness.ts";
import { HERMES_AGENT, hermesEnv, hermesInstalled, resolveHermes } from "./hermes.ts";
import type { Notify } from "./notify.ts";
import { OpenCodeHost, type OpenCodeOptions } from "./opencode.ts";
import type { RunnerPolicy } from "./policy.ts";
import { projectDir } from "./projects.ts";
import { shellEnv } from "./pty.ts";

/**
 * Perch's gateway as ACP describes an MCP server (task 1.17). The bearer is Perch's own, minted for
 * this session: the provider's credential stays in the api's vault and never reaches this process
 * (AGENTS.md §1.6). The token lives in the agent's argument list, not in the runner's environment,
 * so it is never inherited by anything the agent spawns.
 */
function acpMcpServers(servers: SessionMcpServer[]): AcpSessionOptions["mcpServers"] {
  return servers.map((server) =>
    "url" in server
      ? {
          type: "http" as const,
          name: server.name,
          url: server.url,
          headers: [{ name: "authorization", value: `Bearer ${server.token}` }],
        }
      : {
          // Spawned beside the agent (task 3.21): Playwright's browser has to be where the page
          // is. Nothing here carries a credential — it is a command line on this machine.
          type: "stdio" as const,
          name: server.name,
          command: server.command,
          args: server.args ?? [],
          env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
        },
  );
}

export type SessionsOptions = {
  root: string;
  policy: RunnerPolicy;
  notify?: Notify;
  /** Hosted homes (/data/homes/<user>): an agent runs with the person's HOME. */
  homes?: string;
  /** The ACP agents this runner may launch (default: the registry table plus PERCH_ACP_AGENTS). */
  agents?: Record<string, AcpAgentSpec>;
  /** The agent for a session that names none (default: PERCH_ACP_AGENT, else gemini). */
  defaultAgent?: string;
  /** Sessions with no round for this long are closed (default 30 min). */
  idleMs?: number;
  /** OpenCode: the binary, or a running server for tests. */
  opencode?: OpenCodeOptions;
  /** The cli-harness lane: only local runners allow it (the person's own login); the CLIs it knows. */
  cliHarness?: { allowed: boolean; tools?: Record<string, CliHarnessSpec> };
  /** The environment the runner looks for engines in; the process's own unless a test says. */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
};

/** What every hosted engine's session answers to the manager. */
export interface HostedSession {
  readonly busy: boolean;
  readonly engineSessionId: string | null;
  runTurn(
    text: string,
    mode?: RunnerRequestParams<"session.send">["mode"],
    reasoning?: RunnerRequestParams<"session.send">["reasoning"],
  ): Promise<void>;
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

  /**
   * The engines this runner hosts: acp always, opencode when its binary (or server) is there,
   * cli-harness on local runners (behind the api's feature flag).
   */
  engines(): string[] {
    return [
      "acp",
      ...(this.opencode.available() ? ["opencode"] : []),
      ...(hermesInstalled(this.options.env) ? ["hermes"] : []),
      ...(this.options.cliHarness?.allowed ? ["cli-harness"] : []),
    ];
  }

  async create(params: RunnerRequestParams<"session.create">): Promise<SessionCreateResult> {
    if (this.sessions.has(params.session_id)) {
      throw new RunnerRpcError(JSON_RPC_ERRORS.invalidParams, "the session is already open here");
    }
    if (params.engine === "opencode") return this.createOpenCode(params);
    if (params.engine === "cli-harness") return this.createCliHarness(params);
    // Hermes speaks ACP itself (task 3.8), so it is the same client with its own launcher and the
    // model it was asked for; everything after this line is shared with any registry agent.
    if (params.engine === "hermes") return this.createHermes(params);
    if (params.engine !== "acp") {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.invalidParams,
        `engine ${params.engine} is not available on this runner (${this.engines().join(", ")})`,
      );
    }
    // The program to run is `agent`; a brain's provider ("openai", "ollama") names a model, not an
    // agent, so it no longer selects one (ADR-0081).
    const agentId = params.agent ?? this.defaultAgent;
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
    return await this.openAcp(params, { id: agentId, name: spec.name }, launch, spec.env ?? {});
  }

  /**
   * Hermes Agent (spec §3.3 `hermes`; task 3.8). The launcher is Hermes' own ACP server and the
   * model travels as `HERMES_INFERENCE_MODEL`; its provider configuration and any subscription it
   * signed in with live in the user's home volume and are never read here (§3.6 Lane B).
   */
  private async createHermes(
    params: RunnerRequestParams<"session.create">,
  ): Promise<SessionCreateResult> {
    const launch = resolveHermes(this.options.env);
    if (!launch) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.internal,
        "Hermes Agent is not installed on this runner (needs `hermes` or `hermes-acp` on PATH)",
      );
    }
    return await this.openAcp(params, HERMES_AGENT, launch, hermesEnv(params.model));
  }

  /** One ACP session, however the agent behind it was chosen. */
  private async openAcp(
    params: RunnerRequestParams<"session.create">,
    agent: { id: string; name: string },
    launch: AgentLaunch,
    extraEnv: Record<string, string>,
  ): Promise<SessionCreateResult> {
    const agentId = agent.id;
    const cwd = this.cwdOf(params);
    const env = { ...this.envOf(params), ...extraEnv };
    const sessionId = params.session_id;
    const acp = await AcpSession.open({
      sessionId,
      projectId: params.project,
      cwd,
      launch,
      env,
      mode: params.mode,
      policy: this.options.policy,
      ...(params.mcp_servers?.length ? { mcpServers: acpMcpServers(params.mcp_servers) } : {}),
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
        runTurn: (text, mode, reasoning) => acp.runTurn(text, mode, reasoning),
        answerPermission: (id, answer) => acp.answerPermission(id, answer),
        cancel: () => acp.cancel(),
        close: () => acp.close(),
      },
      lastUsed: Date.now(),
    });
    return {
      ...(acp.agentSessionId ? { engine_session_id: acp.agentSessionId } : {}),
      agent: { id: agentId, name: agent.name },
      ...(acp.modes ? { modes: acp.modes } : {}),
    };
  }

  private async createOpenCode(
    params: RunnerRequestParams<"session.create">,
  ): Promise<SessionCreateResult> {
    if (!this.opencode.available()) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.internal,
        "OpenCode is not installed on this runner (needs opencode on PATH, or PERCH_OPENCODE_URL)",
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

  private async createCliHarness(
    params: RunnerRequestParams<"session.create">,
  ): Promise<SessionCreateResult> {
    if (!this.options.cliHarness?.allowed) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.invalidParams,
        "the cli-harness engine runs only on a local runner, under its owner's own login",
      );
    }
    const tools = this.options.cliHarness.tools ?? CLI_HARNESS;
    const known = Object.keys(tools);
    // Which CLI is the whole choice here, so it is named rather than guessed — unless this runner
    // has only one, in which case there is nothing to guess (ADR-0081).
    const cliId = params.agent ?? (known.length === 1 ? known[0] : null);
    if (!cliId) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.invalidParams,
        `name the CLI to run (${known.join(", ")})`,
      );
    }
    const spec = tools[cliId];
    if (!spec) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.invalidParams,
        `unknown CLI ${cliId} (known: ${known.join(", ")})`,
      );
    }
    const binary = isAbsolute(spec.command)
      ? existsSync(spec.command)
        ? spec.command
        : null
      : Bun.which(spec.command);
    if (!binary) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.internal,
        `${spec.name} is not installed on this machine (needs ${spec.command} on PATH)`,
      );
    }
    const cwd = this.cwdOf(params);
    const sessionId = params.session_id;
    const session = new CliHarnessSession({
      sessionId,
      cwd,
      env: this.envOf(params),
      mode: params.mode,
      spec: { ...spec, command: binary },
      emit: (event) => this.emitEvent(sessionId, event),
      log: (line) => this.options.log?.(`[${cliId} ${sessionId.slice(0, 8)}] ${line}`),
    });
    this.sessions.set(sessionId, {
      params,
      session: {
        get busy() {
          return session.busy;
        },
        get engineSessionId() {
          return session.engineSessionId;
        },
        runTurn: (text, mode) => session.runTurn(text, mode),
        answerPermission: () => session.answerPermission(),
        cancel: () => session.cancel(),
        close: () => session.close(),
      },
      lastUsed: Date.now(),
    });
    return {
      agent: { id: cliId, name: spec.name },
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
      .runTurn(params.turn.text, params.mode, params.reasoning)
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
