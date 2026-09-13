/**
 * Spike 0.4.9 — the api half of the preview tunnel (spec §5.6, §7.6 http.open).
 *
 * One control WebSocket per runner at /api/runner (JSON-RPC 2.0). When a browser hits /p/<port>/<path>
 * the api mints a stream token, asks the runner to `http.open`, and pairs the runner's data socket at
 * /api/runner/stream/<token> with the browser request: HTTP requests become head + body frames; WebSocket
 * upgrades (Vite HMR) are relayed frame by frame. This is a prototype of the mechanism, not the final
 * runner protocol implementation (task 1.19).
 */
import type { Server, ServerWebSocket } from "bun";

type Ctx =
  | { kind: "runner" }
  | { kind: "stream"; token: string }
  | { kind: "client-ws"; token: string; port: number; path: string; protocols: string | null };

type Head = { type: "head"; status: number; headers: [string, string][] };
type Control =
  | Head
  | { type: "end" }
  | { type: "ws-open" }
  | { type: "ws-text"; data: string }
  | { type: "ws-close"; code: number; reason: string };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export type TunnelApi = { port: number; url: string; stop: () => void; hasRunner: () => boolean };

const debug = process.env.PERCH_TUNNEL_DEBUG
  ? (...a: unknown[]) => console.error("[api]", ...a)
  : () => {};

export function startTunnelApi(port = 0): TunnelApi {
  let runner: ServerWebSocket<Ctx> | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const streamWaiters = new Map<string, (ws: ServerWebSocket<Ctx>) => void>();
  // HTTP responses in flight, keyed by stream token.
  const httpSinks = new Map<
    string,
    { head: (h: Head) => void; chunk: (c: Uint8Array) => void; end: () => void }
  >();
  // WebSocket relays: token → { client, stream, clientQueue }
  const relays = new Map<
    string,
    {
      client: ServerWebSocket<Ctx> | null;
      stream: ServerWebSocket<Ctx> | null;
      queue: (string | Uint8Array)[];
    }
  >();

  function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!runner) return Promise.reject(new Error("no runner connected"));
    const id = nextId++;
    runner.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`rpc ${method} timed out`));
      }, 15_000);
    });
  }

  function waitForStream(token: string): Promise<ServerWebSocket<Ctx>> {
    return new Promise((resolve, reject) => {
      streamWaiters.set(token, resolve);
      setTimeout(() => {
        if (streamWaiters.delete(token)) reject(new Error("runner never opened the stream"));
      }, 15_000);
    });
  }

  const server: Server<Ctx> = Bun.serve<Ctx>({
    hostname: "127.0.0.1",
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/api/runner") {
        return srv.upgrade(req, { data: { kind: "runner" } })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      const streamMatch = url.pathname.match(/^\/api\/runner\/stream\/([A-Za-z0-9_-]+)$/);
      if (streamMatch) {
        const token = streamMatch[1] ?? "";
        return srv.upgrade(req, { data: { kind: "stream", token } })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      const previewMatch = url.pathname.match(/^\/p\/(\d+)(\/.*)?$/);
      if (!previewMatch) return new Response("not found", { status: 404 });
      if (!runner) return new Response("no runner connected", { status: 503 });
      const targetPort = Number(previewMatch[1]);
      const path = `${previewMatch[2] ?? "/"}${url.search}`;
      const token = crypto.randomUUID();

      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocols = req.headers.get("sec-websocket-protocol");
        relays.set(token, { client: null, stream: null, queue: [] });
        const ok = srv.upgrade(req, {
          data: { kind: "client-ws", token, port: targetPort, path, protocols },
          headers: protocols
            ? { "Sec-WebSocket-Protocol": protocols.split(",")[0]?.trim() ?? "" }
            : {},
        });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }

      const headers: [string, string][] = [];
      req.headers.forEach((v, k) => {
        headers.push([k, v]);
      });
      const streamReady = waitForStream(token);
      await rpc("http.open", {
        port: targetPort,
        path,
        method: req.method,
        headers,
        stream_token: token,
        upgrade: false,
      });
      const stream = await streamReady;

      let headResolve: (h: Head) => void = () => {};
      const headPromise = new Promise<Head>((resolve) => {
        headResolve = resolve;
      });
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      httpSinks.set(token, {
        head: (h) => headResolve(h),
        chunk: (c) => controller?.enqueue(c),
        end: () => {
          controller?.close();
          httpSinks.delete(token);
        },
      });

      const reqBody = req.body ? new Uint8Array(await req.arrayBuffer()) : null;
      if (reqBody && reqBody.byteLength > 0) stream.send(reqBody);
      stream.send(JSON.stringify({ type: "end" } satisfies Control));

      const head = await headPromise;
      const outHeaders = new Headers();
      for (const [k, v] of head.headers) {
        if (["content-length", "content-encoding", "transfer-encoding", "connection"].includes(k))
          continue;
        outHeaders.append(k, v);
      }
      return new Response(body, { status: head.status, headers: outHeaders });
    },
    websocket: {
      open(ws) {
        const data = ws.data;
        debug("open", data.kind, "token" in data ? data.token.slice(0, 8) : "");
        if (data.kind === "runner") {
          runner = ws;
        } else if (data.kind === "stream") {
          const waiter = streamWaiters.get(data.token);
          if (waiter) {
            streamWaiters.delete(data.token);
            waiter(ws);
          }
          const relay = relays.get(data.token);
          if (relay) {
            relay.stream = ws;
            for (const m of relay.queue) ws.send(m);
            relay.queue = [];
          }
        } else if (data.kind === "client-ws") {
          void rpc("http.open", {
            port: data.port,
            path: data.path,
            method: "GET",
            headers: [],
            stream_token: data.token,
            upgrade: true,
            protocols: data.protocols,
          }).catch(() => ws.close(1011, "runner refused"));
          const relay = relays.get(data.token);
          if (relay) relay.client = ws;
        }
      },
      message(ws, message) {
        const data = ws.data;
        debug(
          "message",
          data.kind,
          typeof message === "string" ? message.slice(0, 80) : "<binary>",
        );
        if (data.kind === "runner") {
          const msg = JSON.parse(String(message)) as {
            id?: number;
            result?: unknown;
            error?: { message: string };
          };
          if (msg.id !== undefined) {
            const p = pending.get(msg.id);
            if (p) {
              pending.delete(msg.id);
              msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
            }
          }
          return;
        }
        if (data.kind === "stream") {
          const relay = relays.get(data.token);
          if (relay) {
            // WebSocket relay: runner → browser
            if (typeof message === "string") {
              const control = JSON.parse(message) as Control;
              if (control.type === "ws-text") relay.client?.send(control.data);
              else if (control.type === "ws-close")
                relay.client?.close(control.code, control.reason);
            } else {
              relay.client?.send(new Uint8Array(message));
            }
            return;
          }
          const sink = httpSinks.get(data.token);
          if (!sink) return;
          if (typeof message === "string") {
            const control = JSON.parse(message) as Control;
            if (control.type === "head") sink.head(control);
            else if (control.type === "end") sink.end();
          } else {
            sink.chunk(new Uint8Array(message));
          }
          return;
        }
        if (data.kind === "client-ws") {
          const relay = relays.get(data.token);
          if (!relay) return;
          const frame =
            typeof message === "string"
              ? JSON.stringify({ type: "ws-text", data: message } satisfies Control)
              : new Uint8Array(message);
          if (relay.stream) relay.stream.send(frame);
          else relay.queue.push(frame);
        }
      },
      close(ws, code, reason) {
        const data = ws.data;
        debug("close", data.kind, code, reason);
        if (data.kind === "runner") runner = null;
        if (data.kind === "client-ws") {
          const relay = relays.get(data.token);
          relay?.stream?.send(JSON.stringify({ type: "ws-close", code, reason } satisfies Control));
          relays.delete(data.token);
        }
        if (data.kind === "stream") {
          const relay = relays.get(data.token);
          if (relay) relay.client?.close(1001, "runner stream closed");
          httpSinks.get(data.token)?.end();
        }
      },
    },
  });

  return {
    port: server.port ?? 0,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    hasRunner: () => runner !== null,
  };
}
