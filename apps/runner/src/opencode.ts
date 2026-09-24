/**
 * The OpenCode adapter (spec §3.3 "opencode = OpenCode's extras beyond ACP"; task 1.10, ADR-0076):
 * one `opencode serve` per project directory, driven through the official SDK; a Perch session is
 * an OpenCode session on it. Prompts run as the `build` or `plan` agent; the server's SSE stream is
 * mapped onto EngineEvents (text deltas, tool calls and results with the edit tools' diffs,
 * permission requests answered through session.permission, usage, done). The adapter is the only
 * code touching OpenCode's API.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import {
  type AssistantMessage,
  createOpencodeClient,
  type Event,
  type FileDiff as OpenCodeFileDiff,
  type OpencodeClient,
  type Part,
  type Permission,
} from "@opencode-ai/sdk/client";
import type { EngineEvent, FileDiff, PermissionAnswer, SessionMode } from "@perch/events";
import { unifiedDiff } from "./diff.ts";
import { asUser, type RunAs } from "./identity.ts";
import { projectRelative } from "./paths.ts";

export type OpenCodeOptions = {
  /** The opencode binary (default: `opencode` on PATH). */
  binary?: string;
  /** A server already running, for every directory (tests); nothing is spawned then. */
  baseUrl?: string;
  /** How long to wait for `opencode serve` to listen (default 60 s). */
  startTimeoutMs?: number;
  /** Extra environment for the server (provider credentials arrive with brains, task 1.15). */
  env?: Record<string, string>;
  log?: (line: string) => void;
};

/**
 * A server already running, named by the environment. `opencode serve` is a long-lived process
 * anyone can start themselves — on the machine, or beside the runner — and a runner told where it
 * is talks to that one instead of spawning its own per project.
 */
export function opencodeUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.PERCH_OPENCODE_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The binary this runner would launch, or null. */
export function opencodeBinary(options: Pick<OpenCodeOptions, "binary"> = {}): string | null {
  if (options.binary) {
    if (isAbsolute(options.binary)) return existsSync(options.binary) ? options.binary : null;
    return Bun.which(options.binary);
  }
  return Bun.which("opencode");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    probe.on("error", reject);
  });
}

/** One SSE subscription per server, fanned out to the sessions on it. */
class ServerEvents {
  private readonly handlers = new Set<(event: Event) => void>();
  private stopped = false;
  private stop: (() => void) | null = null;

  constructor(
    private readonly client: OpencodeClient,
    private readonly log?: (line: string) => void,
  ) {}

  start(): void {
    void (async () => {
      while (!this.stopped) {
        try {
          const subscription = await this.client.event.subscribe();
          const iterator = subscription.stream[Symbol.asyncIterator]();
          this.stop = () => void iterator.return?.(undefined);
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            for (const handler of this.handlers) handler(next.value as Event);
          }
        } catch (error) {
          if (!this.stopped) this.log?.(`event stream dropped: ${String(error)}`);
        }
        if (!this.stopped) await new Promise((r) => setTimeout(r, 500));
      }
    })();
  }

  on(handler: (event: Event) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.stopped = true;
    this.stop?.();
    this.handlers.clear();
  }
}

type Server = {
  cwd: string;
  url: string;
  proc: ChildProcess | null;
  client: OpencodeClient;
  events: ServerEvents;
  sessions: Set<string>;
  lastUsed: number;
};

const CONFIG = { autoupdate: false, share: "disabled" } as const;

/** Starts `opencode serve` for a directory and waits for its "listening" line (as the SDK does). */
async function serve(
  binary: string,
  cwd: string,
  env: Record<string, string>,
  user: RunAs,
  timeoutMs: number,
  log?: (line: string) => void,
): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
  // As the member whose sessions it serves: the server is theirs alone (serverKey), and so is its uid.
  const run = asUser(user, [binary, "serve", "--hostname=127.0.0.1", `--port=${port}`], {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(CONFIG),
  });
  const [file = binary, ...args] = run.argv;
  const proc = spawn(file, args, {
    cwd,
    env: run.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`opencode serve did not start within ${timeoutMs} ms`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split("\n")) if (line.trim()) log?.(line);
      if (settled) return;
      const match = /opencode server listening.*?on\s+(https?:\/\/\S+)/.exec(output);
      if (match?.[1]) {
        settled = true;
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`opencode serve exited with code ${code}: ${output.trim()}`));
    });
    proc.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
  return { url, proc };
}

/**
 * Which server a session belongs on: the project directory and the environment it was started
 * with. `opencode serve` reads its provider credentials from its environment once, at start, so a
 * server is only right for sessions with the same environment — the same person's HOME and
 * `PERCH_USER`, the same brain's key. Keyed by cwd alone, the second person on a project would
 * have run on the first one's credentials (AGENTS.md §1.6: personal credentials are user-scoped).
 * A server named by the environment (`PERCH_OPENCODE_URL`) is one process this runner did not
 * start and cannot give an environment to; it is keyed by directory, and its credentials are its
 * operator's — shared, as §1.6 allows for API keys and local models.
 */
export function serverKey(cwd: string, env: Record<string, string>, external: boolean): string {
  if (external) return cwd;
  const hasher = new Bun.CryptoHasher("sha256");
  for (const [key, value] of Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hasher.update(`${key}=${value}\0`);
  }
  return `${cwd}\0${hasher.digest("hex")}`;
}

/** The OpenCode servers of this runner: one per project directory and environment, started on first use. */
export class OpenCodeHost {
  private readonly servers = new Map<string, Server>();

  private readonly options: OpenCodeOptions;

  constructor(options: OpenCodeOptions = {}) {
    const fromEnv = options.baseUrl ? null : opencodeUrl();
    this.options = fromEnv ? { ...options, baseUrl: fromEnv } : options;
  }

  /** Whether sessions can open here: a server to talk to, or a binary to start one. */
  available(): boolean {
    return Boolean(this.options.baseUrl || opencodeBinary(this.options));
  }

  private async server(cwd: string, env: Record<string, string>, user: RunAs): Promise<Server> {
    // Whom it runs as is part of what it is: two members never share a server (ADR-0171).
    const key = serverKey(
      cwd,
      user === null ? env : { ...env, "perch:run-as": user },
      Boolean(this.options.baseUrl),
    );
    const existing = this.servers.get(key);
    if (existing) return existing;
    let url: string;
    let proc: ChildProcess | null = null;
    if (this.options.baseUrl) {
      url = this.options.baseUrl;
    } else {
      const binary = opencodeBinary(this.options);
      if (!binary) throw new Error("OpenCode is not installed on this runner (opencode on PATH)");
      const started = await serve(
        binary,
        cwd,
        { ...env, ...(this.options.env ?? {}) },
        user,
        this.options.startTimeoutMs ?? 60_000,
        this.options.log,
      );
      url = started.url;
      proc = started.proc;
      proc.on("exit", () => {
        const current = this.servers.get(key);
        if (current?.proc === proc) {
          current.events.close();
          this.servers.delete(key);
        }
      });
    }
    const client = createOpencodeClient({ baseUrl: url, directory: cwd });
    const events = new ServerEvents(client, this.options.log);
    events.start();
    const server: Server = {
      cwd,
      url,
      proc,
      client,
      events,
      sessions: new Set(),
      lastUsed: Date.now(),
    };
    this.servers.set(key, server);
    return server;
  }

  async open(options: OpenCodeSessionOptions): Promise<OpenCodeSession> {
    const server = await this.server(options.cwd, options.env, options.user);
    const created = await server.client.session.create({
      body: { title: options.title ?? `Perch ${options.sessionId.slice(0, 8)}` },
    });
    if (created.error || !created.data) {
      throw new Error(`OpenCode refused the session: ${describeError(created.error)}`);
    }
    server.sessions.add(created.data.id);
    server.lastUsed = Date.now();
    return new OpenCodeSession(options, server, created.data.id);
  }

  /** Stops servers with no session left that were idle for `idleMs`. */
  reap(idleMs: number): void {
    const cutoff = Date.now() - idleMs;
    for (const [key, server] of this.servers) {
      if (server.sessions.size === 0 && server.lastUsed < cutoff) {
        this.servers.delete(key);
        server.events.close();
        server.proc?.kill();
      }
    }
  }

  closeAll(): void {
    for (const [key, server] of this.servers) {
      this.servers.delete(key);
      server.events.close();
      server.proc?.kill();
    }
  }
}

function describeError(error: unknown): string {
  if (!error) return "unknown error";
  if (typeof error === "object") {
    const e = error as { name?: unknown; data?: { message?: unknown }; message?: unknown };
    const message = e.data?.message ?? e.message;
    if (typeof message === "string" && message) {
      return typeof e.name === "string" ? `${e.name}: ${message}` : message;
    }
    if (typeof e.name === "string") return e.name;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

export type OpenCodeSessionOptions = {
  sessionId: string;
  cwd: string;
  env: Record<string, string>;
  /** Whom the server runs as (ADR-0171). */
  user: RunAs;
  mode: SessionMode;
  model?: { providerID: string; modelID: string };
  title?: string;
  emit: (event: EngineEvent) => void;
};

type Turn = {
  seenText: Map<string, number>;
  tools: Map<string, { reported: boolean }>;
  reportedFiles: Set<string>;
  tokens: { input: number; output: number };
  cost: number;
  error: string | null;
  idle: boolean;
  wake: (() => void) | null;
};

function fileDiffFrom(cwd: string, metadata: Record<string, unknown> | undefined): FileDiff | null {
  if (!metadata) return null;
  const raw = metadata.filediff as Partial<OpenCodeFileDiff> | undefined;
  const patch = typeof metadata.diff === "string" ? metadata.diff : undefined;
  if (raw && typeof raw.file === "string") {
    const path = projectRelative(cwd, raw.file);
    const before = typeof raw.before === "string" ? raw.before : "";
    const after = typeof raw.after === "string" ? raw.after : "";
    const computed = patch === undefined ? unifiedDiff(path, before || null, after) : null;
    return {
      path,
      patch: patch ?? computed?.patch ?? "",
      additions: typeof raw.additions === "number" ? raw.additions : (computed?.additions ?? 0),
      deletions: typeof raw.deletions === "number" ? raw.deletions : (computed?.deletions ?? 0),
      status: before === "" ? "added" : after === "" ? "deleted" : "modified",
    };
  }
  const filepath = metadata.filepath;
  if (patch !== undefined && typeof filepath === "string") {
    const lines = patch.split("\n");
    const additions = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const deletions = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
    return {
      path: projectRelative(cwd, filepath),
      patch,
      additions,
      deletions,
      status: metadata.exists === false ? "added" : "modified",
    };
  }
  return null;
}

/**
 * The session diff is cumulative; only files a tool did not already report this turn, and whose
 * content moved since they were last reported, become the turn's diff tool call.
 */
function turnDiff(
  cwd: string,
  diffs: OpenCodeFileDiff[],
  reportedThisTurn: Set<string>,
  known: Map<string, string>,
): FileDiff[] {
  const out: FileDiff[] = [];
  for (const entry of diffs) {
    const path = projectRelative(cwd, entry.file);
    if (reportedThisTurn.has(path)) {
      known.set(path, entry.after);
      continue;
    }
    if (known.get(path) === entry.after) continue;
    known.set(path, entry.after);
    const unified = unifiedDiff(path, entry.before === "" ? null : entry.before, entry.after);
    out.push({
      path,
      patch: unified.patch,
      additions: entry.additions,
      deletions: entry.deletions,
      status: entry.before === "" ? "added" : entry.after === "" ? "deleted" : "modified",
    });
  }
  return out;
}

const RESPONSES: Record<PermissionAnswer, "once" | "always" | "reject"> = {
  allow: "once",
  always: "always",
  deny: "reject",
};

/** A Perch session on an OpenCode server. */
export class OpenCodeSession {
  private turn: Turn | null = null;
  private pending: { id: string; sessionID: string } | null = null;
  private readonly children = new Set<string>();
  /** Files reported so far and their content then, so a cumulative session diff repeats nothing. */
  private readonly known = new Map<string, string>();
  private closed = false;

  constructor(
    private readonly options: OpenCodeSessionOptions,
    private readonly server: Server,
    readonly engineSessionId: string,
  ) {}

  get busy(): boolean {
    return this.turn !== null;
  }

  get pendingPermission(): string | null {
    return this.pending?.id ?? null;
  }

  private ownsEvent(sessionID: string | undefined): boolean {
    return sessionID === this.engineSessionId || (!!sessionID && this.children.has(sessionID));
  }

  /** One round: the prompt as the plan or build agent; its events become EngineEvents. */
  async runTurn(text: string, mode?: SessionMode): Promise<void> {
    if (this.closed) {
      this.options.emit({ type: "error", message: "the OpenCode server is gone" });
      return;
    }
    if (this.turn) throw new Error("a round is already running");
    const turn: Turn = {
      seenText: new Map(),
      tools: new Map(),
      reportedFiles: new Set(),
      tokens: { input: 0, output: 0 },
      cost: 0,
      error: null,
      idle: false,
      wake: null,
    };
    this.turn = turn;
    this.server.lastUsed = Date.now();
    const off = this.server.events.on((event) => this.onEvent(turn, event));
    try {
      const response = await this.server.client.session.prompt({
        path: { id: this.engineSessionId },
        body: {
          parts: [{ type: "text", text }],
          agent: mode ?? this.options.mode,
          ...(this.options.model ? { model: this.options.model } : {}),
        },
      });
      if (response.error) {
        this.options.emit({ type: "error", message: describeError(response.error) });
        return;
      }
      // The SSE stream may trail the HTTP answer by a moment: let session.idle land first.
      await this.settle(turn, 2_000);
      const info = response.data?.info as AssistantMessage | undefined;
      const tokens = info?.tokens ?? turn.tokens;
      const cost = info?.cost ?? turn.cost;
      const extra = turnDiff(
        this.options.cwd,
        await this.sessionDiff(),
        turn.reportedFiles,
        this.known,
      );
      if (extra.length > 0) {
        const id = `diff-${Date.now().toString(36)}`;
        this.options.emit({
          type: "tool_call",
          id,
          name: "diff",
          args: { files: extra.map((d) => d.path) },
        });
        this.options.emit({
          type: "tool_result",
          id,
          output: extra.map((d) => `${d.path} +${d.additions} -${d.deletions}`).join("\n"),
          diff: extra,
        });
      }
      this.options.emit({
        type: "usage",
        input: tokens.input,
        output: tokens.output,
        costUsd: Math.max(0, cost),
      });
      const failure = info?.error;
      if (failure && failure.name !== "MessageAbortedError") {
        this.options.emit({ type: "error", message: describeError(failure) });
        return;
      }
      if (turn.error && !failure) {
        this.options.emit({ type: "error", message: turn.error });
        return;
      }
      this.options.emit({ type: "done" });
    } finally {
      off();
      this.turn = null;
      this.pending = null;
    }
  }

  private settle(turn: Turn, ms: number): Promise<void> {
    if (turn.idle) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        turn.wake = null;
        resolve();
      }, ms);
      turn.wake = () => {
        clearTimeout(timer);
        turn.wake = null;
        resolve();
      };
    });
  }

  private async sessionDiff(): Promise<OpenCodeFileDiff[]> {
    try {
      const result = await this.server.client.session.diff({ path: { id: this.engineSessionId } });
      return result.data ?? [];
    } catch {
      return [];
    }
  }

  private onEvent(turn: Turn, event: Event): void {
    switch (event.type) {
      case "session.created": {
        const info = event.properties.info;
        if (info.parentID === this.engineSessionId) this.children.add(info.id);
        return;
      }
      case "message.part.updated": {
        const part = event.properties.part;
        if (part.sessionID !== this.engineSessionId) return;
        this.onPart(turn, part, event.properties.delta);
        return;
      }
      case "permission.updated": {
        const permission = event.properties;
        if (!this.ownsEvent(permission.sessionID)) return;
        this.onPermission(permission);
        return;
      }
      case "session.error": {
        if (!this.ownsEvent(event.properties.sessionID)) return;
        turn.error = describeError(event.properties.error);
        return;
      }
      case "session.idle": {
        if (event.properties.sessionID !== this.engineSessionId) return;
        turn.idle = true;
        turn.wake?.();
        return;
      }
      default:
        return;
    }
  }

  private onPart(turn: Turn, part: Part, delta: string | undefined): void {
    switch (part.type) {
      case "text": {
        if (part.synthetic) return;
        const seen = turn.seenText.get(part.id) ?? 0;
        const text = delta ?? part.text.slice(seen);
        turn.seenText.set(part.id, delta === undefined ? part.text.length : seen + delta.length);
        if (text) this.options.emit({ type: "text", delta: text });
        return;
      }
      case "tool": {
        const state = part.state;
        let known = turn.tools.get(part.callID);
        if (!known) {
          known = { reported: false };
          turn.tools.set(part.callID, known);
          this.options.emit({
            type: "tool_call",
            id: part.callID,
            name: part.tool,
            args: state.input,
          });
        }
        if ((state.status === "completed" || state.status === "error") && !known.reported) {
          known.reported = true;
          const diff = fileDiffFrom(this.options.cwd, state.metadata);
          if (diff) turn.reportedFiles.add(diff.path);
          this.options.emit({
            type: "tool_result",
            id: part.callID,
            output: state.status === "completed" ? state.output : state.error,
            ...(diff ? { diff: [diff] } : {}),
          });
        }
        return;
      }
      case "step-finish": {
        turn.tokens.input += part.tokens.input;
        turn.tokens.output += part.tokens.output;
        turn.cost += part.cost;
        return;
      }
      default:
        return;
    }
  }

  private onPermission(permission: Permission): void {
    this.pending = { id: permission.id, sessionID: permission.sessionID };
    this.options.emit({
      type: "permission",
      id: permission.id,
      tool: permission.title || permission.type,
      args: {
        type: permission.type,
        ...(permission.pattern ? { pattern: permission.pattern } : {}),
        ...permission.metadata,
      },
    });
  }

  /** The person's answer, forwarded to the server (once, always, or reject). */
  async answerPermission(permissionId: string, answer: PermissionAnswer): Promise<boolean> {
    if (!this.pending || this.pending.id !== permissionId) return false;
    const pending = this.pending;
    this.pending = null;
    const result = await this.server.client.postSessionIdPermissionsPermissionId({
      path: { id: pending.sessionID, permissionID: pending.id },
      body: { response: RESPONSES[answer] },
    });
    if (result.error) throw new Error(describeError(result.error));
    return true;
  }

  /** Aborts the running round; the prompt then answers with an aborted message. */
  async cancel(): Promise<boolean> {
    if (!this.turn || this.closed) return false;
    await this.server.client.session.abort({ path: { id: this.engineSessionId } });
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.server.sessions.delete(this.engineSessionId);
    this.server.lastUsed = Date.now();
  }
}
