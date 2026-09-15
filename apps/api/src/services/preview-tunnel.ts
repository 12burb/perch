/**
 * The preview tunnel, api side (spec §5.6 "for local runners the api tunnels HTTP/WS through the
 * runner's connection (§7.6 http.open)"; task 1.19, ADR-0086).
 *
 * A hosted runner shares a network with the api and is proxied to directly (task 1.18). A laptop is
 * not: it opened a WebSocket outward and that is the only way back. So the api asks it for
 * `http.open`, gets a stream token, and the whole exchange — the browser's request, the dev
 * server's answer, or a WebSocket relayed frame for frame — crosses that stream.
 */
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  type RunnerLink,
  type RunnerStream,
  TUNNEL_HEAD_TIMEOUT_MS,
  type TunnelFrame,
} from "@perch/events";
import { z } from "zod";
import { PerchError } from "../errors.ts";

const openResultSchema = z.object({ stream_token: z.string().min(1) });

/** Headers that belong to one hop, and Perch's own credentials, which a dev server never sees. */
const STRIPPED = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
  "authorization",
  "host",
]);

export type TunnelTarget = {
  link: RunnerLink;
  port: number;
  workspaceId: string;
  userId: string;
};

function headersFor(request: Request, target: TunnelTarget): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of request.headers) {
    if (STRIPPED.has(name.toLowerCase())) continue;
    out.push([name, value]);
  }
  const url = new URL(request.url);
  out.push(["host", `127.0.0.1:${target.port}`]);
  out.push(["x-forwarded-proto", url.protocol.replace(":", "")]);
  out.push(["x-forwarded-host", url.host]);
  return out;
}

/** Opens the stream `http.open` answered with, or says why it could not. */
async function openStream(
  target: TunnelTarget,
  params: { path: string; method: string; headers: [string, string][] } & {
    upgrade?: boolean;
    protocols?: string | null;
  },
): Promise<RunnerStream> {
  if (!target.link.openStream) {
    throw PerchError.conflict("this runner cannot open streams");
  }
  const raw = await target.link.call("http.open", {
    workspace_id: target.workspaceId,
    user_id: target.userId,
    port: target.port,
    path: params.path,
    method: params.method,
    headers: params.headers,
    ...(params.upgrade ? { upgrade: true } : {}),
    ...(params.protocols ? { protocols: params.protocols } : {}),
  });
  const { stream_token } = openResultSchema.parse(raw);
  return target.link.openStream(stream_token);
}

/** One request through the tunnel, answered as a normal Response with a streamed body. */
export async function tunnelRequest(
  target: TunnelTarget,
  request: Request,
  path: string,
): Promise<Response> {
  const stream = await openStream(target, {
    path,
    method: request.method,
    headers: headersFor(request, target),
  });

  // The request's body, in order, then the end marker the runner waits for.
  const sendBody = async () => {
    try {
      if (request.body && request.method !== "GET" && request.method !== "HEAD") {
        const reader = request.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) stream.send(encodeTunnelFrame({ kind: "bytes", data: value }));
        }
      }
    } finally {
      if (!stream.closed) stream.send(encodeTunnelFrame({ kind: "end" }));
    }
  };

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stream.close();
      reject(PerchError.upstream("the preview did not answer in time", { port: target.port }));
    }, TUNNEL_HEAD_TIMEOUT_MS);

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });

    const onFrame = (frame: TunnelFrame) => {
      if (frame.kind === "head") {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const headers = new Headers();
        for (const [name, value] of frame.headers) {
          if (STRIPPED.has(name.toLowerCase())) continue;
          headers.append(name, value);
        }
        if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
        resolve(
          new Response(frame.status === 204 || frame.status === 304 ? null : body, {
            status: frame.status,
            statusText: frame.statusText,
            headers,
          }),
        );
        return;
      }
      if (frame.kind === "bytes") {
        controller?.enqueue(frame.data);
        return;
      }
      if (frame.kind === "end") {
        controller?.close();
        controller = null;
        stream.close();
        return;
      }
      if (frame.kind === "error") {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(PerchError.upstream(frame.message, { port: target.port }));
        } else {
          controller?.error(new Error(frame.message));
          controller = null;
        }
        stream.close();
      }
    };

    stream.onMessage((raw) => {
      const frame = decodeTunnelFrame(raw);
      if (frame) onFrame(frame);
    });
    stream.onClose(() => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(PerchError.conflict(`nothing is listening on port ${target.port} yet`));
        return;
      }
      try {
        controller?.close();
      } catch {
        // already closed
      }
      controller = null;
    });

    void sendBody().catch(() => stream.close());
  });
}

/** A socket through the tunnel: the browser's frames in, the dev server's out. */
export type TunnelSocket = {
  /** Resolves when the dev server accepted the upgrade; rejects when it did not. */
  ready: Promise<{ protocol: string }>;
  send(frame: string | Uint8Array): void;
  onMessage(handler: (frame: string | Uint8Array) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  close(): void;
};

export async function tunnelSocket(
  target: TunnelTarget,
  request: Request,
  path: string,
): Promise<TunnelSocket> {
  const protocols = request.headers.get("sec-websocket-protocol");
  const stream = await openStream(target, {
    path,
    method: "GET",
    headers: headersFor(request, target),
    upgrade: true,
    protocols,
  });

  const messages = new Set<(frame: string | Uint8Array) => void>();
  const closers = new Set<(code: number, reason: string) => void>();
  let settle: ((value: { protocol: string }) => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const ready = new Promise<{ protocol: string }>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let opened = false;

  stream.onMessage((raw) => {
    const frame = decodeTunnelFrame(raw);
    if (!frame) return;
    if (frame.kind === "open") {
      opened = true;
      settle?.({ protocol: frame.protocol });
      return;
    }
    if (frame.kind === "text") {
      for (const handler of messages) handler(frame.text);
      return;
    }
    if (frame.kind === "bytes") {
      for (const handler of messages) handler(frame.data);
      return;
    }
    if (frame.kind === "close") {
      for (const handler of closers) handler(frame.code, frame.reason);
      stream.close();
      return;
    }
    if (frame.kind === "error") {
      if (!opened) fail?.(new Error(frame.message));
      stream.close();
    }
  });
  stream.onClose(() => {
    if (!opened) fail?.(new Error("the preview socket closed before it opened"));
    for (const handler of closers) handler(1000, "");
  });

  return {
    ready,
    send(frame) {
      if (stream.closed) return;
      stream.send(
        encodeTunnelFrame(
          typeof frame === "string"
            ? { kind: "text", text: frame }
            : { kind: "bytes", data: frame },
        ),
      );
    },
    onMessage(handler) {
      messages.add(handler);
    },
    onClose(handler) {
      closers.add(handler);
    },
    close() {
      if (!stream.closed) stream.send(encodeTunnelFrame({ kind: "close", code: 1000, reason: "" }));
      stream.close();
    },
  };
}
