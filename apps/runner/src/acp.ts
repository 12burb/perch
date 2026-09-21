/**
 * The ACP adapter (spec §3.3 "acp = THE contract", ADR-0013; task 1.9, ADR-0075): any registry agent
 * becomes an engine. The runner spawns the agent over stdio, speaks the Agent Client Protocol with
 * the official SDK, and maps session updates onto EngineEvents for the api: text chunks, tool calls
 * and their results (with diffs), permission requests (answered through session.permission), usage,
 * done. The agent's file reads and writes go through the client capabilities, confined to the
 * session's directory and the runner's policy.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  EngineEvent,
  FileDiff,
  PermissionAnswer,
  ReasoningLevel,
  SessionMode,
} from "@perch/events";
import { unifiedDiff } from "./diff.ts";
import type { Notify } from "./notify.ts";
import { projectRelative } from "./paths.ts";
import { enforce, type RunnerPolicy } from "./policy.ts";

/** How a registry agent is launched: a binary on PATH, or an npm package through npx. */
export type AcpAgentSpec = {
  name: string;
  command?: string;
  args?: string[];
  npx?: { package: string; args?: string[] };
  env?: Record<string, string>;
};

/**
 * The ACP registry's entries for the agents the runner image ships or can fetch (registry v1,
 * 2026-09-14). A binary on PATH wins over npx, which is what makes a session on the image start
 * without fetching anything (task 4.6); the npx pins are the fallback for a machine that has
 * nothing installed, and for the four the image ships they are the same versions as
 * `deploy/agents.json` — `apps/runner/test/agents.test.ts` holds the two in step.
 */
export const ACP_AGENTS: Record<string, AcpAgentSpec> = {
  gemini: {
    name: "Gemini CLI",
    command: "gemini",
    args: ["--acp"],
    npx: { package: "@google/gemini-cli@0.60.0", args: ["--acp"] },
  },
  codex: {
    name: "Codex",
    command: "codex-acp",
    npx: { package: "@agentclientprotocol/codex-acp@1.12.0" },
  },
  claude: {
    name: "Claude Agent",
    command: "claude-agent-acp",
    npx: { package: "@agentclientprotocol/claude-agent-acp@0.78.0" },
  },
  goose: { name: "goose", command: "goose", args: ["acp"] },
  opencode: { name: "OpenCode", command: "opencode", args: ["acp"] },
  qwen: {
    name: "Qwen Code",
    command: "qwen",
    args: ["--acp", "--experimental-skills"],
    npx: { package: "@qwen-code/qwen-code@0.23.3", args: ["--acp", "--experimental-skills"] },
  },
  cline: {
    name: "Cline",
    command: "cline",
    args: ["--acp"],
    npx: { package: "cline@3.0.61", args: ["--acp"] },
  },
};

/** Agents from PERCH_ACP_AGENTS (a JSON object of id → spec) on top of the built-in table. */
export function agentTable(env: NodeJS.ProcessEnv = process.env): Record<string, AcpAgentSpec> {
  const table = { ...ACP_AGENTS };
  const raw = env.PERCH_ACP_AGENTS;
  if (!raw) return table;
  try {
    const parsed = JSON.parse(raw) as Record<string, AcpAgentSpec>;
    for (const [id, spec] of Object.entries(parsed)) {
      if (spec && typeof spec === "object" && typeof spec.name === "string") table[id] = spec;
    }
  } catch {
    // a malformed PERCH_ACP_AGENTS is ignored; the built-in table stands
  }
  return table;
}

export type AgentLaunch = { file: string; args: string[] };

/** How to start the agent on this machine, or null when nothing here can. */
export function resolveAgentLaunch(spec: AcpAgentSpec): AgentLaunch | null {
  if (spec.command) {
    if (isAbsolute(spec.command) && existsSync(spec.command)) {
      return { file: spec.command, args: spec.args ?? [] };
    }
    const found = Bun.which(spec.command);
    if (found) return { file: found, args: spec.args ?? [] };
  }
  if (spec.npx) {
    const npx = Bun.which("npx");
    if (npx) return { file: npx, args: ["-y", spec.npx.package, ...(spec.npx.args ?? [])] };
  }
  return null;
}

/** Agents whose binary is on PATH right now (the runner reports them in its capabilities). */
export function installedAgents(table: Record<string, AcpAgentSpec> = ACP_AGENTS): string[] {
  return Object.entries(table)
    .filter(
      ([, spec]) =>
        spec.command &&
        (isAbsolute(spec.command) ? existsSync(spec.command) : Bun.which(spec.command)),
    )
    .map(([id]) => id);
}

/** Perch's plan/build onto the agent's own modes: an id or name that says "plan", else the rest. */
export function pickMode(
  wanted: SessionMode,
  available: Array<{ id: string; name: string }>,
): string | null {
  const isPlan = (m: { id: string; name: string }) => /plan/i.test(`${m.id} ${m.name}`);
  const plan = available.find(isPlan);
  if (wanted === "plan") return plan?.id ?? null;
  const build =
    available.find((m) => /^(build|code|act|agent|default|auto|normal|edit)$/i.test(m.id)) ??
    available.find((m) => !isPlan(m));
  return build?.id ?? null;
}

/**
 * Perch's reasoning level onto an agent's own session config (task 2.18, ADR-0111).
 *
 * ACP 1.4 gives a select option the category `thought_level` for exactly this, so that is what is
 * looked for first; an agent that names the option something recognisable is taken second. The
 * level is then matched to one of the option's own values by id or name, and failing that by
 * position — first is least, last is most — because "low" and "minimal" are the same intent under
 * two names, and refusing to map them would make the control do nothing on most agents.
 */
export function pickThoughtOption(
  options: readonly acp.SessionConfigOption[] | null | undefined,
): (acp.SessionConfigOption & { type: "select" }) | null {
  const selects = (options ?? []).filter(
    (one): one is acp.SessionConfigOption & { type: "select" } => one.type === "select",
  );
  return (
    selects.find((one) => one.category === "thought_level") ??
    selects.find((one) => /reason|effort|think|thought/i.test(`${one.id} ${one.name}`)) ??
    null
  );
}

const THOUGHT_WORDS: Record<Exclude<ReasoningLevel, "auto">, RegExp> = {
  low: /^(low|minimal|none|off|fast|quick|lite)$/i,
  medium: /^(medium|default|balanced|normal|standard|auto)$/i,
  high: /^(high|max|maximum|deep|thorough|extended|hard)$/i,
};

export function pickThoughtValue(
  level: ReasoningLevel,
  option: acp.SessionConfigOption & { type: "select" },
): string | null {
  if (level === "auto") return null;
  const flat: Array<{ value: string; name: string }> = [];
  for (const entry of option.options) {
    if ("options" in entry) {
      for (const one of entry.options) flat.push({ value: one.value, name: one.name });
    } else {
      flat.push({ value: entry.value, name: entry.name });
    }
  }
  if (flat.length === 0) return null;
  const word = THOUGHT_WORDS[level];
  const named = flat.find((one) => word.test(one.value) || word.test(one.name));
  if (named) return named.value;
  // By position, so an agent with its own vocabulary still gets least, middle, most.
  const at = level === "low" ? 0 : level === "high" ? flat.length - 1 : (flat.length - 1) >> 1;
  return flat[at]?.value ?? null;
}

const MAX_OUTPUT = 64 * 1024;

function textOf(content: acp.ToolCallContent[] | null | undefined): string {
  if (!content) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (entry.type === "content" && entry.content.type === "text") parts.push(entry.content.text);
  }
  return parts.join("\n");
}

function diffsOf(
  content: acp.ToolCallContent[] | null | undefined,
  cwd: string,
): FileDiff[] | undefined {
  if (!content) return undefined;
  const diffs: FileDiff[] = [];
  for (const entry of content) {
    if (entry.type !== "diff") continue;
    const path = projectRelative(cwd, entry.path);
    const unified = unifiedDiff(path, entry.oldText, entry.newText);
    diffs.push({
      path,
      patch: unified.patch,
      additions: unified.additions,
      deletions: unified.deletions,
      status: entry.oldText == null ? "added" : "modified",
    });
  }
  return diffs.length > 0 ? diffs : undefined;
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (truncated)` : text;
}

/** An error's message, with the details the SDK tucks into a JSON-RPC error's data. */
export function describeError(error: unknown): string {
  if (error instanceof acp.RequestError) {
    const details = (error.data as { details?: unknown } | null)?.details;
    return typeof details === "string" && details ? `${error.message}: ${details}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** A refusal the agent can read: the client's reason travels in the error's message and data. */
function refuse(message: string): never {
  throw acp.RequestError.invalidParams({ details: message }, message);
}

/** Answers `allow` / `always` / `deny` with the agent's closest option; cancelled when the round was. */
export function selectPermissionOption(
  options: acp.PermissionOption[],
  answer: PermissionAnswer | "cancelled",
): acp.RequestPermissionResponse {
  if (answer === "cancelled") return { outcome: { outcome: "cancelled" } };
  const preference: acp.PermissionOptionKind[] =
    answer === "allow"
      ? ["allow_once", "allow_always"]
      : answer === "always"
        ? ["allow_always", "allow_once"]
        : ["reject_once", "reject_always"];
  for (const kind of preference) {
    const option = options.find((o) => o.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  const first = options[0];
  if (!first) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: first.optionId } };
}

export type AcpSessionOptions = {
  /** Perch's session id; also what the api uses in session.* calls. */
  sessionId: string;
  projectId: string;
  /** The session's directory: the project, or one of its worktrees. */
  cwd: string;
  launch: AgentLaunch;
  env: Record<string, string>;
  mode: SessionMode;
  policy: RunnerPolicy;
  mcpServers?: acp.McpServer[];
  emit: (event: EngineEvent) => void;
  notify?: Notify;
  /** stderr of the agent, one line at a time (logging). */
  onStderr?: (line: string) => void;
};

type PendingPermission = { id: string; resolve: (answer: PermissionAnswer | "cancelled") => void };

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (e: Error) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One agent process speaking ACP for one Perch session. */
export class AcpSession {
  readonly agentSessionId: string;
  readonly modes: { current: string; available: Array<{ id: string; name: string }> } | null;
  private currentMode: string | null;
  /** The reasoning value already set on the agent, so a repeat turn does not ask again. */
  private currentThought: string | null = null;
  private pending: PendingPermission | null = null;
  private permissionCounter = 0;
  private turning = false;
  private closed = false;
  private usage: { input: number; output: number } = { input: 0, output: 0 };
  private cost = 0;
  private readonly tools = new Map<string, { title: string; reported: boolean }>();
  private readonly closedSignal: Deferred<void>;

  private constructor(
    private readonly options: AcpSessionOptions,
    private readonly proc: ChildProcess,
    private readonly ctx: acp.ClientContext,
    private readonly active: acp.ActiveSession,
    closedSignal: Deferred<void>,
  ) {
    this.agentSessionId = active.sessionId;
    const modes = active.modes;
    this.modes = modes
      ? {
          current: modes.currentModeId,
          available: modes.availableModes.map((m) => ({ id: m.id, name: m.name })),
        }
      : null;
    this.currentMode = modes?.currentModeId ?? null;
    this.closedSignal = closedSignal;
  }

  /** Spawns the agent, initializes, opens the session; rejects when any of that fails. */
  static async open(options: AcpSessionOptions): Promise<AcpSession> {
    const proc = spawn(options.launch.file, options.launch.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stderr?.setEncoding("utf8");
    let stderrCarry = "";
    proc.stderr?.on("data", (chunk: string) => {
      stderrCarry += chunk;
      const lines = stderrCarry.split("\n");
      stderrCarry = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) options.onStderr?.(line);
    });
    const ready = deferred<AcpSession>();
    const closedSignal = deferred<void>();
    let session: AcpSession | null = null;
    const exited = deferred<void>();
    proc.on("error", (error) => {
      ready.reject(new Error(`could not start ${options.launch.file}: ${error.message}`));
      exited.resolve();
    });
    proc.on("exit", (code, signal) => {
      exited.resolve();
      ready.reject(
        new Error(`the agent exited before the session opened (${signal ?? `code ${code}`})`),
      );
      session?.onExit(code, signal);
    });
    if (!proc.stdin || !proc.stdout) throw new Error("agent stdio unavailable");
    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    );
    const run = acp
      .client({ name: "perch-runner" })
      .onRequest(acp.methods.client.session.requestPermission, (rc) => {
        if (!session) return { outcome: { outcome: "cancelled" as const } };
        return session.onPermission(rc.params);
      })
      .onRequest(acp.methods.client.fs.readTextFile, (rc) => {
        if (!session) throw new Error("no session");
        return session.readTextFile(rc.params);
      })
      .onRequest(acp.methods.client.fs.writeTextFile, (rc) => {
        if (!session) throw new Error("no session");
        return session.writeTextFile(rc.params);
      })
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        });
        const request: acp.NewSessionRequest = {
          cwd: options.cwd,
          mcpServers: options.mcpServers ?? [],
        };
        const active = await ctx.buildSession(request).start();
        session = new AcpSession(options, proc, ctx, active, closedSignal);
        await session.ensureMode(options.mode).catch(() => {});
        ready.resolve(session);
        await closedSignal.promise;
        active.dispose();
      });
    run.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ready.reject(new Error(`the agent did not open a session: ${message}`));
      session?.onConnectionLost(message);
    });
    try {
      return await ready.promise;
    } catch (error) {
      closedSignal.resolve();
      proc.kill();
      throw error;
    }
  }

  get busy(): boolean {
    return this.turning;
  }

  get pendingPermission(): string | null {
    return this.pending?.id ?? null;
  }

  private onExit(code: number | null, signal: string | null): void {
    if (this.closed) return;
    this.onConnectionLost(`the agent exited (${signal ?? `code ${code}`})`);
  }

  private onConnectionLost(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closedSignal.resolve();
    if (this.pending) {
      this.pending.resolve("cancelled");
      this.pending = null;
    }
    if (this.turning) {
      this.turning = false;
      this.options.emit({ type: "error", message });
    }
  }

  /** Perch's plan/build onto the agent's modes; a no-op for agents without modes. */
  async ensureMode(mode: SessionMode): Promise<void> {
    if (!this.modes) return;
    const target = pickMode(mode, this.modes.available);
    if (!target || target === this.currentMode) return;
    await this.ctx.request(acp.methods.agent.session.setMode, {
      sessionId: this.agentSessionId,
      modeId: target,
    });
    this.currentMode = target;
  }

  /**
   * Perch's reasoning level onto the agent's own session config. A no-op for `auto`, and for an
   * agent that advertises nothing to set — the level is still what Perch recorded, and the docs
   * say which agents can act on it.
   */
  async ensureReasoning(level: ReasoningLevel): Promise<void> {
    if (level === "auto") return;
    const option = pickThoughtOption(this.active.newSessionResponse.configOptions);
    if (!option) return;
    const value = pickThoughtValue(level, option);
    if (!value || value === this.currentThought) return;
    await this.ctx.request(acp.methods.agent.session.setConfigOption, {
      sessionId: this.agentSessionId,
      configId: option.id,
      value,
    });
    this.currentThought = value;
  }

  /** One round: the prompt, its updates as EngineEvents, and done or error at the end. */
  async runTurn(text: string, mode?: SessionMode, reasoning?: ReasoningLevel): Promise<void> {
    if (this.closed) {
      this.options.emit({ type: "error", message: "the agent is gone" });
      return;
    }
    if (this.turning) throw new Error("a round is already running");
    this.turning = true;
    try {
      if (mode) await this.ensureMode(mode);
      // An agent that refuses the option still answers the turn; the level is a preference.
      if (reasoning) await this.ensureReasoning(reasoning).catch(() => {});
      let failure: string | null = null;
      const prompt = this.active.prompt(text).catch((error: unknown) => {
        failure = describeError(error);
        return null;
      });
      try {
        for (;;) {
          const message = await Promise.race([this.active.nextUpdate(), prompt.then(() => null)]);
          if (message === null) {
            // the prompt settled: a rejection (an update never comes), or a stop already queued
            if (failure !== null) {
              this.options.emit({ type: "error", message: failure });
              return;
            }
            continue;
          }
          if (message.kind === "stop") {
            this.onStop(message.response);
            return;
          }
          this.onUpdate(message.update);
        }
      } catch (error) {
        // the update queue rejected (the agent answered the prompt with an error, or went away)
        this.options.emit({ type: "error", message: failure ?? describeError(error) });
      }
    } finally {
      this.turning = false;
      if (this.pending) {
        this.pending.resolve("cancelled");
        this.pending = null;
      }
    }
  }

  private onStop(response: acp.PromptResponse): void {
    const usage = response.usage;
    if (usage) {
      // Cumulative across the session in ACP; the api wants the round's share.
      const input = Math.max(0, usage.inputTokens - this.usage.input);
      const output = Math.max(0, usage.outputTokens - this.usage.output);
      this.usage = { input: usage.inputTokens, output: usage.outputTokens };
      const cost = this.cost;
      this.cost = 0;
      this.options.emit({ type: "usage", input, output, costUsd: cost });
    } else if (this.cost > 0) {
      this.options.emit({ type: "usage", input: 0, output: 0, costUsd: this.cost });
      this.cost = 0;
    }
    if (response.stopReason === "refusal") {
      this.options.emit({ type: "error", message: "the agent refused the request" });
      return;
    }
    this.options.emit({ type: "done" });
  }

  private onUpdate(update: acp.SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.options.emit({ type: "text", delta: update.content.text });
        }
        return;
      case "tool_call": {
        this.tools.set(update.toolCallId, { title: update.title, reported: false });
        this.options.emit({
          type: "tool_call",
          id: update.toolCallId,
          name: update.title,
          args: update.rawInput ?? (update.locations ? { locations: update.locations } : {}),
        });
        if (update.status === "completed" || update.status === "failed") {
          this.reportResult(update.toolCallId, update.status, update.content, update.rawOutput);
        }
        return;
      }
      case "tool_call_update": {
        if (update.title) {
          const known = this.tools.get(update.toolCallId);
          if (known) known.title = update.title;
        }
        if (update.status === "completed" || update.status === "failed") {
          this.reportResult(update.toolCallId, update.status, update.content, update.rawOutput);
        }
        return;
      }
      case "current_mode_update":
        this.currentMode = update.currentModeId;
        return;
      case "usage_update":
        if (update.cost && update.cost.currency.toUpperCase() === "USD") {
          this.cost = Math.max(this.cost, update.cost.amount);
        }
        return;
      default:
        return;
    }
  }

  private reportResult(
    toolCallId: string,
    status: "completed" | "failed",
    content: acp.ToolCallContent[] | null | undefined,
    rawOutput: unknown,
  ): void {
    const known = this.tools.get(toolCallId);
    if (known?.reported) return;
    if (known) known.reported = true;
    let output = textOf(content);
    if (!output && rawOutput !== undefined && rawOutput !== null) {
      output = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
    }
    if (!output) output = status;
    const diff = diffsOf(content, this.options.cwd);
    this.options.emit({
      type: "tool_result",
      id: toolCallId,
      output: clip(output),
      ...(diff ? { diff } : {}),
    });
  }

  private async onPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    // The tool_call notification before this request is still in the update queue: let the
    // round's loop emit it first so the transcript keeps the agent's order.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const id = `p${++this.permissionCounter}`;
    const call = params.toolCall;
    const known = call.toolCallId ? this.tools.get(call.toolCallId) : undefined;
    this.options.emit({
      type: "permission",
      id,
      tool: call.title ?? known?.title ?? call.kind ?? call.toolCallId,
      args: call.rawInput ?? { toolCallId: call.toolCallId },
    });
    return new Promise((resolve) => {
      this.pending = {
        id,
        resolve: (answer) => resolve(selectPermissionOption(params.options, answer)),
      };
    });
  }

  /** The person's answer to the permission the agent is waiting on. */
  answerPermission(permissionId: string, answer: PermissionAnswer): boolean {
    if (!this.pending || this.pending.id !== permissionId) return false;
    const pending = this.pending;
    this.pending = null;
    pending.resolve(answer);
    return true;
  }

  /** Asks the agent to stop the round; a waiting permission counts as cancelled. */
  async cancel(): Promise<boolean> {
    if (!this.turning || this.closed) return false;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      pending.resolve("cancelled");
    }
    await this.ctx.notify(acp.methods.agent.session.cancel, { sessionId: this.agentSessionId });
    return true;
  }

  /** Ends the agent process. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closedSignal.resolve();
    if (this.pending) {
      this.pending.resolve("cancelled");
      this.pending = null;
    }
    if (this.proc.exitCode === null && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
      }, 2_000);
      timer.unref?.();
      // Closed means gone: a killed process still holds its working directory until it has
      // exited (Windows refuses to remove it until then), so this waits for the exit, bounded.
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(limit);
          resolve();
        };
        const limit = setTimeout(done, 3_000);
        limit.unref?.();
        this.proc.once("exit", done);
        this.proc.once("error", done);
      });
    }
  }

  /** An absolute path the agent named, kept inside the session's directory. */
  private inside(path: string): { absolute: string; rel: string } {
    const absolute = resolve(this.options.cwd, path);
    const rel = relative(this.options.cwd, absolute);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      refuse(`path is outside the session's directory: ${path}`);
    }
    return { absolute, rel: rel.split(sep).join("/") };
  }

  private readTextFile(params: acp.ReadTextFileRequest): acp.ReadTextFileResponse {
    const { absolute, rel } = this.inside(params.path);
    try {
      enforce(this.options.policy, { kind: "fs.read", project: this.options.projectId, path: rel });
    } catch (error) {
      refuse(error instanceof Error ? error.message : String(error));
    }
    if (!existsSync(absolute)) refuse(`no such file: ${rel}`);
    const content = readFileSync(absolute, "utf8");
    if (params.line == null && params.limit == null) return { content };
    const lines = content.split("\n");
    const start = Math.max(0, (params.line ?? 1) - 1);
    const end = params.limit == null ? lines.length : start + params.limit;
    return { content: lines.slice(start, end).join("\n") };
  }

  private writeTextFile(params: acp.WriteTextFileRequest): acp.WriteTextFileResponse {
    const { absolute, rel } = this.inside(params.path);
    try {
      enforce(this.options.policy, {
        kind: "fs.write",
        project: this.options.projectId,
        path: rel,
      });
    } catch (error) {
      refuse(error instanceof Error ? error.message : String(error));
    }
    const existed = existsSync(absolute) && statSync(absolute).isFile();
    if (!existsSync(dirname(absolute))) refuse(`directory does not exist: ${dirname(rel)}`);
    writeFileSync(absolute, params.content, "utf8");
    this.options.notify?.({
      method: "fs.changed",
      params: {
        project: this.options.projectId,
        paths: [rel],
        kind: existed ? "change" : "create",
      },
    });
    return {};
  }
}
