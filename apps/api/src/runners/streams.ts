/**
 * Data streams beside the control channel (spec §7.6 "/api/runner/stream/{stream_token}", task
 * 1.7, ADR-0073): a runner answers pty.open with a token, then opens a second socket for it; the
 * api pairs that socket with the caller awaiting the token. Either side may arrive first, so both
 * wait a little for the other. Tokens are single-use and bound to the runner that minted them.
 */
import type { RunnerStream } from "@perch/events";
import type { WSContext } from "hono/ws";

const WAIT_MS = 15_000;

/**
 * A RunnerStream over the runner's stream socket, fed by the endpoint's socket handlers. Frames
 * that arrive before the consumer listens (a scrollback replay right after the socket opens) are
 * kept for the first listener.
 */
export class SocketStream implements RunnerStream {
  private readonly handlers = new Set<(data: string) => void>();
  private readonly closers = new Set<() => void>();
  private buffered: string[] = [];
  private isClosed = false;

  constructor(private readonly ws: WSContext<unknown>) {}

  send(data: string): void {
    if (this.ws.readyState === 1) this.ws.send(data);
  }

  onMessage(handler: (data: string) => void): () => void {
    this.handlers.add(handler);
    if (this.buffered.length > 0) {
      const pending = this.buffered;
      this.buffered = [];
      for (const data of pending) handler(data);
    }
    return () => this.handlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closers.add(handler);
    return () => this.closers.delete(handler);
  }

  close(): void {
    if (this.ws.readyState === 0 || this.ws.readyState === 1) this.ws.close(1000, "done");
    this.markClosed();
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Called by the endpoint when a frame arrives. */
  deliver(data: string): void {
    if (this.handlers.size === 0) {
      this.buffered.push(data);
      return;
    }
    for (const handler of this.handlers) handler(data);
  }

  /** Called by the endpoint when the socket closes. */
  markClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const handler of this.closers) handler();
  }
}

type Waiter = { runnerId: string; resolve: (s: RunnerStream) => void; timer: Timer };
type Early = { runnerId: string; stream: SocketStream; timer: Timer };

export class StreamHub {
  private readonly waiting = new Map<string, Waiter>();
  private readonly early = new Map<string, Early>();

  constructor(private readonly waitMs: number = WAIT_MS) {}

  /** The link awaits the runner's socket for a token it was just handed. */
  open(runnerId: string, token: string): Promise<RunnerStream> {
    const early = this.early.get(token);
    if (early) {
      this.early.delete(token);
      clearTimeout(early.timer);
      if (early.runnerId !== runnerId) {
        early.stream.close();
        return Promise.reject(new Error("stream token belongs to another runner"));
      }
      return Promise.resolve(early.stream);
    }
    return new Promise<RunnerStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(token);
        reject(new Error(`the runner did not open stream ${token} within ${this.waitMs} ms`));
      }, this.waitMs);
      timer.unref?.();
      this.waiting.set(token, { runnerId, resolve, timer });
    });
  }

  /** The runner's socket for a token arrived; returns the stream to feed, or null when refused. */
  attach(runnerId: string, token: string, ws: WSContext<unknown>): SocketStream | null {
    const stream = new SocketStream(ws);
    const waiter = this.waiting.get(token);
    if (waiter) {
      this.waiting.delete(token);
      clearTimeout(waiter.timer);
      if (waiter.runnerId !== runnerId) {
        stream.close();
        return null;
      }
      waiter.resolve(stream);
      return stream;
    }
    if (this.early.has(token)) {
      stream.close();
      return null;
    }
    const timer = setTimeout(() => {
      this.early.delete(token);
      stream.close();
    }, this.waitMs);
    timer.unref?.();
    this.early.set(token, { runnerId, stream, timer });
    return stream;
  }

  /** Streams that arrived early and nobody claimed. */
  get pending(): number {
    return this.early.size + this.waiting.size;
  }

  closeAll(): void {
    for (const [token, early] of this.early) {
      clearTimeout(early.timer);
      early.stream.close();
      this.early.delete(token);
    }
    for (const [token, waiter] of this.waiting) {
      clearTimeout(waiter.timer);
      this.waiting.delete(token);
    }
  }
}
