/**
 * `mcp.spawn` (spec §7.6 "mcp.spawn {command, args} → stream token"; task 3.24): an MCP server
 * that lives inside the runner, reached over a data stream rather than a URL.
 *
 * The two halves fit exactly. MCP's stdio transport is newline-delimited JSON in both directions,
 * and a runner stream is text frames in both directions — so the runner spawns the process, sends
 * on what it writes, and writes what the api sends. No port is opened, nothing outside the runner
 * can reach it, and the api gets the same MCP it would get from a URL.
 *
 * The command is policy-checked like `exec`: a server nobody may run by hand is not a server
 * somebody may run by writing a row (spec §5.7, ADR-0070).
 */
import { existsSync } from "node:fs";
import { type RunnerRequestParams, type RunnerStream, STREAM_OPEN_TIMEOUT_MS } from "@perch/events";
import { enforce, type RunnerPolicy } from "./policy.ts";
import { projectDir } from "./projects.ts";
import type { StreamOpener } from "./streams.ts";

export type McpHostOptions = {
  root: string;
  policy: RunnerPolicy;
  streams?: StreamOpener;
  log?: (line: string) => void;
};

type Live = {
  proc: ReturnType<typeof Bun.spawn>;
  stream: RunnerStream | null;
  /** What the process wrote before the api's end of the stream arrived. */
  buffered: string[];
};

/** The servers this runner is hosting, one process each, each on its own stream. */
export class McpHost {
  private readonly pending = new Map<
    string,
    { live: Live; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly live = new Set<Live>();

  constructor(private readonly options: McpHostOptions) {}

  /** Start one, and answer with the token the api opens its stream on. */
  spawn(params: RunnerRequestParams<"mcp.spawn">): { stream_token: string } {
    const cwd = params.project
      ? projectDir(this.options.root, params.workspace_id, params.project)
      : this.options.root;
    if (!existsSync(cwd)) {
      throw new Error(
        params.project ? "the project is not on this runner" : "this runner has no projects root",
      );
    }
    // The whole command line, so a policy that denies `rm -rf` denies it here too.
    enforce(this.options.policy, {
      kind: "exec",
      command: [params.command, ...params.args].join(" "),
      cwd,
      root: this.options.root,
    });

    const proc = Bun.spawn([params.command, ...params.args], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const live: Live = { proc, stream: null, buffered: [] };
    this.live.add(live);
    void this.pump(live);
    void this.stderr(live);
    void proc.exited.then(() => {
      this.live.delete(live);
      live.stream?.close();
    });

    const token = crypto.randomUUID();
    const timer = setTimeout(() => {
      this.pending.delete(token);
      this.stop(live);
    }, STREAM_OPEN_TIMEOUT_MS);
    timer.unref?.();
    this.pending.set(token, { live, timer });
    // The socket runner opens the stream itself; the in-process one is handed it by the api.
    if (this.options.streams) {
      this.options.streams
        .open(token)
        .then((stream) => this.attachToken(token, stream))
        .catch(() => {
          this.pending.delete(token);
          this.stop(live);
        });
    }
    return { stream_token: token };
  }

  /** The api (in-process) or the socket client hands over the stream for a token. */
  attachToken(token: string, stream: RunnerStream): boolean {
    const entry = this.pending.get(token);
    if (!entry) {
      stream.close();
      return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(token);
    const live = entry.live;
    if (live.proc.killed) {
      stream.close();
      return false;
    }
    live.stream = stream;
    for (const line of live.buffered.splice(0)) stream.send(line);
    stream.onMessage((data) => {
      // Whatever the api sends is a line of JSON-RPC for the server's stdin.
      const text = data.endsWith("\n") ? data : `${data}\n`;
      const stdin = live.proc.stdin;
      if (stdin && typeof stdin !== "number") {
        stdin.write(text);
        void stdin.flush();
      }
    });
    stream.onClose(() => this.stop(live));
    return true;
  }

  /** Everything this runner is hosting, stopped. */
  closeAll(): void {
    for (const [token, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(token);
      this.stop(entry.live);
    }
    for (const live of [...this.live]) this.stop(live);
  }

  private stop(live: Live): void {
    this.live.delete(live);
    try {
      live.proc.kill();
    } catch {
      // Already gone, which is the state we wanted.
    }
    live.stream?.close();
    live.stream = null;
  }

  /** What the server said, one line per frame: the framing MCP's stdio transport already uses. */
  private async pump(live: Live): Promise<void> {
    const stdout = live.proc.stdout;
    if (!stdout || typeof stdout === "number") return;
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of stdout as ReadableStream<Uint8Array>) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        // The newline goes with it: the api's side buffers frames, and a message that never ends
        // is a message it keeps waiting for.
        const framed = `${line}\n`;
        if (live.stream) live.stream.send(framed);
        else live.buffered.push(framed);
      }
    }
  }

  /** Its complaints are the runner's log, never the api's stream: they are not JSON-RPC. */
  private async stderr(live: Live): Promise<void> {
    const stderr = live.proc.stderr;
    if (!stderr || typeof stderr === "number") return;
    const decoder = new TextDecoder();
    for await (const chunk of stderr as ReadableStream<Uint8Array>) {
      const text = decoder.decode(chunk, { stream: true }).trim();
      if (text) this.options.log?.(text);
    }
  }
}
