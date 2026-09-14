/**
 * The cli-harness adapter (spec §3.3, §3.6 lane C; task 1.11, ADR-0077): the official CLIs in
 * headless mode under the person's own login, on their own machine. Behind the `cli_harness`
 * feature flag (off by default) and only on local runners: a turn spawns the CLI in the project
 * (Codex `exec --json`, Claude Code `-p --output-format stream-json`), its JSONL stream becomes
 * EngineEvents, and the CLI's own session id resumes the conversation on the next turn. The CLIs
 * run with their own approval policies; there are no Perch permission prompts on this lane.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute, relative, sep } from "node:path";
import type { EngineEvent, FileDiff, SessionMode } from "@perch/events";
import { unifiedDiff } from "./diff.ts";

export type CliHarnessSpec = {
  name: string;
  command: string;
  /** Arguments for a turn; `resume` is the CLI's own session id from an earlier turn. */
  args: (turn: {
    prompt: string;
    cwd: string;
    mode: SessionMode;
    resume: string | null;
  }) => string[];
  /** Turns one JSONL line into events; `session` reports the CLI's session id when it appears. */
  parse: (line: Record<string, unknown>, ctx: ParseContext) => EngineEvent[];
};

export type ParseContext = {
  cwd: string;
  /** Called with the CLI's session/thread id, for the next turn's resume. */
  session: (id: string) => void;
  /** Tool calls already reported this turn (so a result can follow a call). */
  tools: Map<string, { name: string }>;
};

function relativePath(cwd: string, file: string): string {
  const rel = isAbsolute(file) ? relative(cwd, file) : file;
  return rel.split(sep).join("/");
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === "string") return block;
        const b = block as { type?: string; text?: string };
        return b.type === "text" && typeof b.text === "string" ? b.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** Codex CLI: `codex exec --json` (thread.started, item.*, turn.completed / turn.failed). */
export function parseCodex(line: Record<string, unknown>, ctx: ParseContext): EngineEvent[] {
  const type = line.type;
  if (type === "thread.started" && typeof line.thread_id === "string") {
    ctx.session(line.thread_id);
    return [];
  }
  if (type === "turn.completed") {
    const usage = (line.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    return [
      {
        type: "usage",
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        costUsd: 0,
      },
      { type: "done" },
    ];
  }
  if (type === "turn.failed" || type === "error") {
    const error = line.error as { message?: string } | undefined;
    const message = error?.message ?? (typeof line.message === "string" ? line.message : "");
    return [{ type: "error", message: message || "the CLI reported an error" }];
  }
  if (type !== "item.started" && type !== "item.completed" && type !== "item.updated") return [];
  const item = line.item as
    | {
        id?: string;
        type?: string;
        text?: string;
        command?: string;
        aggregated_output?: string;
        exit_code?: number;
        status?: string;
        changes?: Array<{ path?: string; kind?: string }>;
        server?: string;
        tool?: string;
        arguments?: unknown;
        result?: unknown;
        error?: { message?: string } | string;
        message?: string;
        query?: string;
      }
    | undefined;
  if (!item || typeof item.id !== "string") return [];
  const events: EngineEvent[] = [];
  const started = type === "item.started";
  const completed = type === "item.completed";
  switch (item.type) {
    case "agent_message":
      if (completed && typeof item.text === "string" && item.text) {
        events.push({ type: "text", delta: item.text });
      }
      break;
    case "command_execution":
      if (!ctx.tools.has(item.id)) {
        ctx.tools.set(item.id, { name: "shell" });
        events.push({
          type: "tool_call",
          id: item.id,
          name: "shell",
          args: { command: item.command ?? "" },
        });
      }
      if (completed) {
        const output = (item.aggregated_output ?? "").trimEnd();
        const exit = typeof item.exit_code === "number" ? `\n(exit ${item.exit_code})` : "";
        events.push({ type: "tool_result", id: item.id, output: `${output}${exit}`.trim() });
      }
      break;
    case "file_change":
      if (completed) {
        const changes = item.changes ?? [];
        if (!ctx.tools.has(item.id)) {
          ctx.tools.set(item.id, { name: "apply_patch" });
          events.push({ type: "tool_call", id: item.id, name: "apply_patch", args: { changes } });
        }
        events.push({
          type: "tool_result",
          id: item.id,
          output: changes
            .map((c) => `${c.kind ?? "update"} ${relativePath(ctx.cwd, c.path ?? "")}`)
            .join("\n"),
        });
      }
      break;
    case "mcp_tool_call":
      if (!ctx.tools.has(item.id)) {
        ctx.tools.set(item.id, { name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}` });
        events.push({
          type: "tool_call",
          id: item.id,
          name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`,
          args: item.arguments ?? {},
        });
      }
      if (completed) {
        const failure =
          typeof item.error === "string" ? item.error : (item.error?.message ?? undefined);
        events.push({ type: "tool_result", id: item.id, output: failure ?? text(item.result) });
      }
      break;
    case "web_search":
      if (started || completed) {
        if (!ctx.tools.has(item.id)) {
          ctx.tools.set(item.id, { name: "web_search" });
          events.push({
            type: "tool_call",
            id: item.id,
            name: "web_search",
            args: { query: item.query ?? "" },
          });
        }
        if (completed) events.push({ type: "tool_result", id: item.id, output: "searched" });
      }
      break;
    case "error":
      events.push({ type: "error", message: item.message ?? "the CLI reported an error" });
      break;
    default:
      break;
  }
  return events;
}

function claudeDiff(cwd: string, name: string, input: Record<string, unknown>): FileDiff | null {
  const filePath = typeof input.file_path === "string" ? input.file_path : null;
  if (!filePath) return null;
  const path = relativePath(cwd, filePath);
  if (name === "Write" && typeof input.content === "string") {
    const unified = unifiedDiff(path, null, input.content);
    return { path, ...unified, status: "added" };
  }
  if (
    name === "Edit" &&
    typeof input.old_string === "string" &&
    typeof input.new_string === "string"
  ) {
    const unified = unifiedDiff(path, input.old_string, input.new_string);
    return { path, ...unified, status: "modified" };
  }
  return null;
}

/** Claude Code: `claude -p --output-format stream-json --verbose` (system, assistant, user, result). */
export function parseClaude(line: Record<string, unknown>, ctx: ParseContext): EngineEvent[] {
  if (typeof line.session_id === "string") ctx.session(line.session_id);
  const type = line.type;
  if (type === "assistant" || type === "user") {
    const message = line.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message?.content as unknown[]) : [];
    const events: EngineEvent[] = [];
    for (const raw of content) {
      const block = raw as {
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      if (type === "assistant" && block.type === "text" && typeof block.text === "string") {
        if (block.text) events.push({ type: "text", delta: block.text });
      } else if (
        type === "assistant" &&
        block.type === "tool_use" &&
        typeof block.id === "string"
      ) {
        const name = block.name ?? "tool";
        const input = block.input ?? {};
        ctx.tools.set(block.id, { name });
        events.push({ type: "tool_call", id: block.id, name, args: input });
        const diff = claudeDiff(ctx.cwd, name, input);
        if (diff) {
          // The edit tools carry their change in the call; report it right away so the diff is
          // in the transcript even if the CLI's tool_result is terse.
          events.push({ type: "tool_result", id: block.id, output: "", diff: [diff] });
          ctx.tools.set(block.id, { name: `${name}:reported` });
        }
      } else if (
        type === "user" &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        const known = ctx.tools.get(block.tool_use_id);
        if (known?.name.endsWith(":reported")) continue;
        events.push({
          type: "tool_result",
          id: block.tool_use_id,
          output: `${block.is_error ? "error: " : ""}${text(block.content)}`,
        });
      }
    }
    return events;
  }
  if (type === "result") {
    const usage = (line.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    const cost = typeof line.total_cost_usd === "number" ? line.total_cost_usd : 0;
    const events: EngineEvent[] = [
      {
        type: "usage",
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        costUsd: cost,
      },
    ];
    const subtype = typeof line.subtype === "string" ? line.subtype : "success";
    if (line.is_error === true || subtype.startsWith("error")) {
      const detail = typeof line.result === "string" && line.result ? `: ${line.result}` : "";
      events.push({ type: "error", message: `${subtype}${detail}` });
    } else {
      events.push({ type: "done" });
    }
    return events;
  }
  return [];
}

/** The CLIs the harness knows, with their documented headless flags. */
export const CLI_HARNESS: Record<string, CliHarnessSpec> = {
  codex: {
    name: "Codex CLI",
    command: "codex",
    args: ({ prompt, cwd, mode, resume }) => [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      cwd,
      "--sandbox",
      mode === "plan" ? "read-only" : "workspace-write",
      ...(resume ? ["resume", resume] : []),
      prompt,
    ],
    parse: parseCodex,
  },
  claude: {
    name: "Claude Code",
    command: "claude",
    args: ({ prompt, mode, resume }) => [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      mode === "plan" ? "plan" : "acceptEdits",
      ...(resume ? ["--resume", resume] : []),
      prompt,
    ],
    parse: parseClaude,
  },
};

export type CliHarnessSessionOptions = {
  sessionId: string;
  cwd: string;
  env: Record<string, string>;
  mode: SessionMode;
  spec: CliHarnessSpec;
  emit: (event: EngineEvent) => void;
  log?: (line: string) => void;
};

/** One CLI conversation: a process per turn, resumed through the CLI's own session id. */
export class CliHarnessSession {
  private proc: ChildProcess | null = null;
  /** A round is over when its stream said done or error, even if the process lingers a moment. */
  private turning = false;
  private cliSessionId: string | null = null;
  private closed = false;

  constructor(private readonly options: CliHarnessSessionOptions) {}

  get busy(): boolean {
    return this.turning;
  }

  /** The CLI's own session id once the first turn reported it. */
  get engineSessionId(): string | null {
    return this.cliSessionId;
  }

  async runTurn(prompt: string, mode?: SessionMode): Promise<void> {
    if (this.closed) {
      this.options.emit({ type: "error", message: "the session is closed" });
      return;
    }
    if (this.turning) throw new Error("a round is already running");
    if (this.proc && this.proc.exitCode === null) this.proc.kill("SIGTERM");
    this.turning = true;
    const { spec, cwd, emit } = this.options;
    const args = spec.args({
      prompt,
      cwd,
      mode: mode ?? this.options.mode,
      resume: this.cliSessionId,
    });
    const proc = spawn(spec.command, args, {
      cwd,
      env: this.options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    const ctx: ParseContext = {
      cwd,
      session: (id) => {
        this.cliSessionId = id;
      },
      tools: new Map(),
    };
    let ended = false;
    let cancelled = false;
    let buffered = "";
    const handleLine = (raw: string) => {
      const line = raw.trim();
      if (!line || ended) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.options.log?.(line);
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      for (const event of spec.parse(parsed as Record<string, unknown>, ctx)) {
        if (ended) break;
        if (event.type === "done" || event.type === "error") {
          ended = true;
          this.turning = false;
        }
        emit(event);
      }
    };
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) if (line.trim()) this.options.log?.(line);
    });
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      proc.on("exit", (code, signal) => resolve({ code, signal }));
      proc.on("error", (error) => {
        this.options.log?.(`could not start ${spec.command}: ${error.message}`);
        resolve({ code: null, signal: null });
      });
    });
    this.cancelHook = () => {
      cancelled = true;
    };
    try {
      const { code, signal } = await exit;
      if (buffered.trim()) handleLine(buffered);
      if (!ended) {
        ended = true;
        this.turning = false;
        if (cancelled || code === 0) emit({ type: "done" });
        else {
          emit({
            type: "error",
            message: `${spec.name} exited with ${signal ?? `code ${code ?? "unknown"}`} before finishing the turn`,
          });
        }
      }
    } finally {
      this.turning = false;
      if (this.proc === proc) this.proc = null;
      this.cancelHook = null;
    }
  }

  private cancelHook: (() => void) | null = null;

  /** No permission prompts on this lane: the CLIs apply their own approval policy. */
  answerPermission(): boolean {
    return false;
  }

  async cancel(): Promise<boolean> {
    const proc = this.proc;
    if (!proc || !this.turning || this.closed) return false;
    this.cancelHook?.();
    proc.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, 2_000);
    timer.unref?.();
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.cancel();
  }
}
