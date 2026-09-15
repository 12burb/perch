/**
 * `http.open` (spec §7.6; task 1.19, ADR-0086): the runner's half of the preview tunnel.
 *
 * A local runner is somewhere the api cannot route to — a laptop behind NAT, usually — so a preview
 * on it travels the other way round, back through the WebSocket the runner opened. The api asks for
 * `http.open`, gets a stream token, and everything the browser said and the dev server answered
 * crosses that stream in the frames of `@perch/events/http-tunnel`.
 *
 * The runner is the one making the request here, so it only ever reaches its own loopback: the
 * port has to be one this machine is listening on, and nothing else is reachable through it.
 */
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  type RunnerRequestParams,
  type RunnerStream,
  type TunnelFrame,
} from "@perch/events";
import type { StreamOpener } from "./streams.ts";

/** A stream token is claimed within this window or forgotten. */
const OPEN_TIMEOUT_MS = 30_000;

type Pending = {
  params: RunnerRequestParams<"http.open">;
  timer: ReturnType<typeof setTimeout>;
};

export type HttpTunnelOptions = {
  streams?: StreamOpener;
  /** Overridable for tests; the real one is the loopback interface. */
  host?: string;
  log?: (line: string) => void;
};

export class HttpTunnel {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: HttpTunnelOptions = {}) {}

  /** Registers the request and answers with the token the stream will arrive under. */
  async open(params: RunnerRequestParams<"http.open">): Promise<{ stream_token: string }> {
    const token = crypto.randomUUID();
    const timer = setTimeout(() => this.pending.delete(token), OPEN_TIMEOUT_MS);
    timer.unref?.();
    this.pending.set(token, { params, timer });
    // The socket runner opens the stream itself; the in-process runner pairs it when the api asks.
    if (this.options.streams) {
      this.options.streams
        .open(token)
        .then((stream) => this.attachToken(token, stream))
        .catch(() => {
          this.pending.delete(token);
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
    const host = this.options.host ?? "127.0.0.1";
    const run = entry.params.upgrade
      ? relaySocket(stream, entry.params, host)
      : relayRequest(stream, entry.params, host);
    run.catch((error: unknown) => {
      this.options.log?.(`http.open failed: ${error instanceof Error ? error.message : error}`);
      send(stream, { kind: "error", message: describe(error) });
      stream.close();
    });
    return true;
  }

  close(): void {
    for (const [token, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(token);
    }
  }
}

function send(stream: RunnerStream, frame: TunnelFrame): void {
  if (!stream.closed) stream.send(encodeTunnelFrame(frame));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Frames as they arrive, in order, until the stream closes. */
function frames(stream: RunnerStream): AsyncIterable<TunnelFrame> {
  const queue: TunnelFrame[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const nudge = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  stream.onMessage((raw) => {
    const frame = decodeTunnelFrame(raw);
    if (frame) queue.push(frame);
    nudge();
  });
  stream.onClose(() => {
    done = true;
    nudge();
  });
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/** One plain HTTP round trip: the request's body in, the response's head and body out. */
async function relayRequest(
  stream: RunnerStream,
  params: RunnerRequestParams<"http.open">,
  host: string,
): Promise<void> {
  const url = `http://${host}:${params.port}${params.path.startsWith("/") ? params.path : `/${params.path}`}`;
  const headers = new Headers();
  for (const [name, value] of params.headers) headers.append(name, value);
  const hasBody = params.method !== "GET" && params.method !== "HEAD";
  const body = hasBody
    ? new ReadableStream<Uint8Array>({
        async start(controller) {
          for await (const frame of frames(stream)) {
            if (frame.kind === "bytes") controller.enqueue(frame.data);
            else if (frame.kind === "end") break;
            else if (frame.kind === "error" || frame.kind === "close") break;
          }
          controller.close();
        },
      })
    : undefined;

  const answer = await fetch(url, {
    method: params.method,
    headers,
    ...(body ? { body, duplex: "half" } : {}),
    redirect: "manual",
  } as RequestInit & { duplex?: "half" });

  send(stream, {
    kind: "head",
    status: answer.status,
    statusText: answer.statusText,
    headers: [...answer.headers.entries()],
  });
  if (answer.body) {
    const reader = answer.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) send(stream, { kind: "bytes", data: value });
    }
  }
  send(stream, { kind: "end" });
  stream.close();
}

/** A WebSocket upgrade, relayed frame for frame until either side hangs up. */
async function relaySocket(
  stream: RunnerStream,
  params: RunnerRequestParams<"http.open">,
  host: string,
): Promise<void> {
  const url = `ws://${host}:${params.port}${params.path.startsWith("/") ? params.path : `/${params.path}`}`;
  const protocols = (params.protocols ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const socket = protocols.length > 0 ? new WebSocket(url, protocols) : new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let opened = false;

  socket.addEventListener("open", () => {
    opened = true;
    send(stream, { kind: "open", protocol: socket.protocol ?? "" });
  });
  socket.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as string | ArrayBuffer;
    if (typeof data === "string") send(stream, { kind: "text", text: data });
    else send(stream, { kind: "bytes", data: new Uint8Array(data) });
  });
  socket.addEventListener("close", (event: CloseEvent) => {
    send(stream, { kind: "close", code: closeCode(event.code), reason: event.reason ?? "" });
    stream.close();
  });
  socket.addEventListener("error", () => {
    if (!opened) send(stream, { kind: "error", message: "the dev server refused the socket" });
    stream.close();
  });

  for await (const frame of frames(stream)) {
    if (socket.readyState !== WebSocket.OPEN) {
      if (frame.kind === "close") break;
      continue;
    }
    if (frame.kind === "text") socket.send(frame.text);
    else if (frame.kind === "bytes") socket.send(frame.data);
    else if (frame.kind === "close" || frame.kind === "end") break;
  }
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(1000, "done");
  }
}

/** 1005 and 1006 mean "no code was given" and may not be sent back on the wire. */
function closeCode(code: number): number {
  return code === 1005 || code === 1006 || code < 1000 ? 1000 : code;
}
