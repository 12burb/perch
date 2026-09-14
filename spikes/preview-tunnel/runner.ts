/**
 * Spike 0.4.9 — the runner half of the preview tunnel. Opens an outbound control WebSocket to the api (no
 * inbound ports), answers `http.open` by connecting a data socket to /api/runner/stream/<token>, and serves
 * the request from the dev server on localhost: plain HTTP via fetch, WebSocket upgrades by relaying frames.
 */

type OpenParams = {
  port: number;
  path: string;
  method: string;
  headers: [string, string][];
  stream_token: string;
  upgrade: boolean;
  protocols?: string | null;
};

type Control =
  | { type: "head"; status: number; headers: [string, string][] }
  | { type: "end" }
  | { type: "ws-open" }
  | { type: "ws-text"; data: string }
  | { type: "ws-close"; code: number; reason: string };

const debug = process.env.PERCH_TUNNEL_DEBUG
  ? (...a: unknown[]) => console.error("[runner]", ...a)
  : () => {};

const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "upgrade",
]);

function openStream(apiUrl: string, token: string): Promise<WebSocket> {
  const wsUrl = apiUrl.replace(/^http/, "ws");
  const ws = new WebSocket(`${wsUrl}/api/runner/stream/${token}`);
  ws.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("stream socket failed"));
  });
}

async function serveHttp(apiUrl: string, p: OpenParams): Promise<void> {
  const stream = await openStream(apiUrl, p.stream_token);
  const chunks: Uint8Array[] = [];
  const bodyDone = new Promise<void>((resolve) => {
    stream.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const control = JSON.parse(ev.data) as Control;
        if (control.type === "end") resolve();
      } else {
        chunks.push(new Uint8Array(ev.data as ArrayBuffer));
      }
    };
  });
  await bodyDone;
  const headers = new Headers();
  for (const [k, v] of p.headers) if (!DROP_REQUEST_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  const body = chunks.length > 0 ? new Blob(chunks) : undefined;
  const res = await fetch(`http://127.0.0.1:${p.port}${p.path}`, {
    method: p.method,
    headers,
    body,
    redirect: "manual",
  });
  const headOut: [string, string][] = [];
  res.headers.forEach((v, k) => {
    headOut.push([k, v]);
  });
  stream.send(
    JSON.stringify({ type: "head", status: res.status, headers: headOut } satisfies Control),
  );
  if (res.body) {
    for await (const chunk of res.body) stream.send(chunk);
  }
  stream.send(JSON.stringify({ type: "end" } satisfies Control));
  stream.close();
}

async function serveWebSocket(apiUrl: string, p: OpenParams): Promise<void> {
  const stream = await openStream(apiUrl, p.stream_token);
  const protocols = p.protocols ? p.protocols.split(",").map((s) => s.trim()) : [];
  debug("ws open", `ws://127.0.0.1:${p.port}${p.path}`, protocols);
  const local = new WebSocket(`ws://127.0.0.1:${p.port}${p.path}`, protocols);
  local.binaryType = "arraybuffer";
  local.onopen = () => {
    debug("local open, protocol", local.protocol);
    stream.send(JSON.stringify({ type: "ws-open" } satisfies Control));
  };
  local.onmessage = (ev) => {
    debug("local message", typeof ev.data === "string" ? ev.data.slice(0, 80) : "<binary>");
    if (typeof ev.data === "string") {
      stream.send(JSON.stringify({ type: "ws-text", data: ev.data } satisfies Control));
    } else {
      stream.send(new Uint8Array(ev.data as ArrayBuffer));
    }
  };
  local.onclose = (ev) => {
    debug("local close", ev.code, ev.reason);
    stream.send(
      JSON.stringify({ type: "ws-close", code: ev.code, reason: ev.reason } satisfies Control),
    );
    stream.close();
  };
  local.onerror = (ev) => {
    debug("local error", String((ev as ErrorEvent).message ?? ev));
    stream.send(
      JSON.stringify({
        type: "ws-close",
        code: 1011,
        reason: "local socket failed",
      } satisfies Control),
    );
    stream.close();
  };
  stream.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const control = JSON.parse(ev.data) as Control;
      if (control.type === "ws-text") local.send(control.data);
      else if (control.type === "ws-close") local.close(control.code, control.reason);
    } else {
      local.send(new Uint8Array(ev.data as ArrayBuffer));
    }
  };
  stream.onclose = () => local.close();
}

export type TunnelRunner = { stop: () => void };

export function connectTunnelRunner(apiUrl: string): Promise<TunnelRunner> {
  const wsUrl = apiUrl.replace(/^http/, "ws");
  const control = new WebSocket(`${wsUrl}/api/runner`);
  control.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { id: number; method: string; params: OpenParams };
    if (msg.method !== "http.open") {
      control.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "method not found" },
        }),
      );
      return;
    }
    control.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stream_token: msg.params.stream_token },
      }),
    );
    const task = msg.params.upgrade
      ? serveWebSocket(apiUrl, msg.params)
      : serveHttp(apiUrl, msg.params);
    task.catch((err: unknown) => console.error("[runner] http.open failed", err));
  };
  return new Promise((resolve, reject) => {
    control.onopen = () => resolve({ stop: () => control.close() });
    control.onerror = () => reject(new Error("control socket failed"));
  });
}
