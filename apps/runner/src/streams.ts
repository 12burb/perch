import type { RunnerStream } from "@perch/events";

/**
 * How a runner reaches the api's stream endpoint (spec §7.6 /api/runner/stream/{token}): the
 * socket client opens a WebSocket with its connect token; the in-process runner hands the api one
 * end of an in-memory pair. Handlers only see `open(token)`.
 */
export type StreamOpener = { open(token: string): Promise<RunnerStream> };

/**
 * The receiving side of a stream: frames that arrive before anyone listens are kept and handed
 * to the first listener (a shell's scrollback replay lands before the api has wired its socket).
 */
export class Inbox {
  private readonly handlers = new Set<(data: string) => void>();
  private buffered: string[] = [];

  deliver(data: string): void {
    if (this.handlers.size === 0) {
      this.buffered.push(data);
      return;
    }
    for (const handler of this.handlers) handler(data);
  }

  subscribe(handler: (data: string) => void): () => void {
    this.handlers.add(handler);
    if (this.buffered.length > 0) {
      const pending = this.buffered;
      this.buffered = [];
      for (const data of pending) handler(data);
    }
    return () => {
      this.handlers.delete(handler);
    };
  }
}

/** Two ends of one in-memory stream: what one sends, the other receives. */
export function createStreamPair(): { a: RunnerStream; b: RunnerStream } {
  const inboxA = new Inbox();
  const inboxB = new Inbox();
  const closeA = new Set<() => void>();
  const closeB = new Set<() => void>();
  let closed = false;
  const closeBoth = () => {
    if (closed) return;
    closed = true;
    for (const handler of closeA) handler();
    for (const handler of closeB) handler();
  };
  const end = (mine: Inbox, theirs: Inbox, myClose: Set<() => void>): RunnerStream => ({
    send(data) {
      if (closed) return;
      // Deliver on a microtask so a send inside a handler cannot re-enter it.
      queueMicrotask(() => {
        if (!closed) theirs.deliver(data);
      });
    },
    onMessage(handler) {
      return mine.subscribe(handler);
    },
    onClose(handler) {
      myClose.add(handler);
      return () => myClose.delete(handler);
    },
    close: closeBoth,
    get closed() {
      return closed;
    },
  });
  return { a: end(inboxA, inboxB, closeA), b: end(inboxB, inboxA, closeB) };
}

/** A RunnerStream over a WebSocket (either side). */
export function streamOverSocket(ws: WebSocket): RunnerStream {
  const inbox = new Inbox();
  const closers = new Set<() => void>();
  let closed = false;
  ws.addEventListener("message", (event) => {
    inbox.deliver(typeof event.data === "string" ? event.data : "");
  });
  ws.addEventListener("close", () => {
    if (closed) return;
    closed = true;
    for (const handler of closers) handler();
  });
  return {
    send(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    onMessage(handler) {
      return inbox.subscribe(handler);
    },
    onClose(handler) {
      closers.add(handler);
      return () => closers.delete(handler);
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "done");
      }
    },
    get closed() {
      return closed;
    },
  };
}
