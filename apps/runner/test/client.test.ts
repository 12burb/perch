import { afterEach, describe, expect, test } from "bun:test";
import { generateCapSecret, mintCap } from "@perch/events";
import type { Server, ServerWebSocket } from "bun";
import { connectRunner, measureLoad, runnerSocketUrl } from "../src/client.ts";

/**
 * Task 1.1: the runner side of the control channel against a small stand-in for the api: an
 * authenticated upgrade, the register handshake, heartbeats, and every check a request goes through
 * before a handler runs (params, capability token, owner).
 */

const WS = "0190f2d0-0000-7000-8000-000000000001";
const OWNER = "0190f2d0-0000-7000-8000-0000000000aa";
const OTHER = "0190f2d0-0000-7000-8000-0000000000bb";
const RUNNER_ID = "0190f2d0-0000-7000-8000-0000000000cc";

type Message = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type FakeApi = {
  server: Server<undefined>;
  url: string;
  registrations: unknown[];
  notifications: Message[];
  responses: Message[];
  socket: () => ServerWebSocket<undefined>;
  waitFor: (predicate: () => boolean, ms?: number) => Promise<void>;
  request: (method: string, params: Record<string, unknown>, cap?: string) => Promise<Message>;
  stop: () => void;
};

const servers: FakeApi[] = [];
afterEach(() => {
  for (const api of servers.splice(0)) api.stop();
});

function fakeApi(
  options: { token?: string; refuse?: boolean; heartbeatMs?: number } = {},
): FakeApi {
  const registrations: unknown[] = [];
  const notifications: Message[] = [];
  const responses: Message[] = [];
  let socket: ServerWebSocket<undefined> | null = null;
  const capSecret = generateCapSecret();
  let seq = 100;
  const waiters = new Map<string, (m: Message) => void>();
  const server = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (
        options.refuse ||
        req.headers.get("authorization") !== `Bearer ${options.token ?? "prt_ok"}`
      ) {
        return new Response("forbidden", { status: 403 });
      }
      if (srv.upgrade(req)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        socket = ws;
      },
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as Message;
        if (message.method === "runner.register" && message.id !== undefined) {
          registrations.push(message.params);
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                runner_id: RUNNER_ID,
                cap_secret: capSecret,
                heartbeat_ms: options.heartbeatMs ?? 50,
                owner_user_id: OWNER,
              },
            }),
          );
          return;
        }
        if (message.method) {
          notifications.push(message);
          return;
        }
        responses.push(message);
        const waiter = waiters.get(String(message.id));
        if (waiter) {
          waiters.delete(String(message.id));
          waiter(message);
        }
      },
      close() {
        socket = null;
      },
    },
  });
  const api: FakeApi = {
    server,
    url: `http://127.0.0.1:${server.port}`,
    registrations,
    notifications,
    responses,
    socket: () => {
      if (!socket) throw new Error("no runner connected");
      return socket;
    },
    waitFor: (predicate, ms = 5_000) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          if (predicate()) resolve();
          else if (Date.now() - started > ms) reject(new Error("timed out waiting"));
          else setTimeout(tick, 10);
        };
        tick();
      }),
    async request(method, params, cap) {
      const id = `${++seq}`;
      const token =
        cap ??
        (await mintCap(capSecret, {
          ws: String(params.workspace_id),
          user: String(params.user_id),
          method,
          exp: Date.now() + 60_000,
        }));
      const answer = new Promise<Message>((resolve) => waiters.set(id, resolve));
      api
        .socket()
        .send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, cap: token } }));
      return answer;
    },
    stop: () => server.stop(true),
  };
  servers.push(api);
  return api;
}

describe("runner client (task 1.1)", () => {
  test("the socket URL comes from the api URL", () => {
    expect(runnerSocketUrl("https://perch.example.com")).toBe("wss://perch.example.com/api/runner");
    expect(runnerSocketUrl("http://127.0.0.1:3000/")).toBe("ws://127.0.0.1:3000/api/runner");
    const load = measureLoad();
    expect(load.cpu).toBeGreaterThanOrEqual(0);
    expect(load.memoryMb).toBeGreaterThanOrEqual(0);
  });

  test("registers with the token, heartbeats on the api's period, and answers checked requests", async () => {
    const api = fakeApi({ heartbeatMs: 30 });
    const statuses: string[] = [];
    const client = connectRunner({
      apiUrl: api.url,
      token: "prt_ok",
      name: "laptop",
      kind: "local",
      ownerUserId: OWNER,
      reconnect: false,
      handlers: {
        "ports.list": async () => ({ ports: [{ port: 5173 }] }),
        exec: async (params) => ({ echoed: params.command }),
      },
    });
    client.onStatus((s) => statuses.push(s));
    const registered = await client.registered();
    expect(registered.runner_id).toBe(RUNNER_ID);
    expect(client.runnerId).toBe(RUNNER_ID);
    expect(client.status).toBe("online");
    const [info] = api.registrations as Array<{
      name: string;
      kind: string;
      capabilities: Record<string, unknown>;
      versions: Record<string, string>;
    }>;
    expect(info?.name).toBe("laptop");
    expect(info?.kind).toBe("local");
    expect(info?.capabilities.platform).toBe(process.platform);
    expect(info?.versions.bun).toBe(Bun.version);

    // Heartbeats: one on registration, then every 30 ms.
    await api.waitFor(
      () => api.notifications.filter((n) => n.method === "runner.heartbeat").length >= 3,
      3_000,
    );
    const beat = api.notifications.find((n) => n.method === "runner.heartbeat")?.params as {
      load: { cpu: number; memoryMb: number };
      sessions: string[];
    };
    expect(beat.sessions).toEqual([]);
    expect(beat.load.memoryMb).toBeGreaterThan(0);

    // A request with a valid capability token for the owner reaches the handler.
    const ok = await api.request("ports.list", { workspace_id: WS, user_id: OWNER });
    expect(ok.result).toEqual({ ports: [{ port: 5173 }] });
    const exec = await api.request("exec", {
      workspace_id: WS,
      user_id: OWNER,
      command: "ls",
      cwd: "/",
      timeout: 1000,
    });
    expect(exec.result).toEqual({ echoed: "ls" });

    // A forged, expired, or mismatched token is refused before any handler runs.
    const forged = await api.request(
      "ports.list",
      { workspace_id: WS, user_id: OWNER },
      "nope.nope",
    );
    expect(forged.error?.code).toBe(-32001);
    const capForOtherMethod = await mintCap(registered.cap_secret, {
      ws: WS,
      user: OWNER,
      method: "fs.read",
      exp: Date.now() + 60_000,
    });
    const mismatched = await api.request(
      "ports.list",
      { workspace_id: WS, user_id: OWNER },
      capForOtherMethod,
    );
    expect(mismatched.error?.code).toBe(-32001);
    expect(mismatched.error?.data).toEqual({ reason: "mismatch" });

    // A local runner serves its owner only, unless a grant is attached.
    const other = await api.request("ports.list", { workspace_id: WS, user_id: OTHER });
    expect(other.error?.code).toBe(-32003);
    const granted = await api.request("ports.list", {
      workspace_id: WS,
      user_id: OTHER,
      grant: "grant-token",
    });
    expect(granted.result).toEqual({ ports: [{ port: 5173 }] });

    // Unknown and unimplemented methods, and bad params.
    const unknown = await api.request("nope.method", { workspace_id: WS, user_id: OWNER });
    expect(unknown.error?.code).toBe(-32601);
    const missing = await api.request("fs.read", {
      workspace_id: WS,
      user_id: OWNER,
      project: WS,
      path: "a",
    });
    expect(missing.error?.code).toBe(-32601);
    const bad = await api.request("exec", { workspace_id: WS, user_id: OWNER, command: "ls" });
    expect(bad.error?.code).toBe(-32602);

    await client.close();
    expect(client.status).toBe("closed");
    expect(statuses).toEqual(["registering", "online", "closed"]);
  });

  test("gives up after the api refuses the upgrade a few times", async () => {
    const api = fakeApi({ refuse: true });
    const client = connectRunner({
      apiUrl: api.url,
      token: "prt_bad",
      reconnect: { minMs: 5, maxMs: 10, maxRefusals: 2 },
    });
    await expect(client.registered()).rejects.toThrow(/refused the connection 2 time/);
    expect(client.status).toBe("closed");
    await client.close();
  });

  test("reconnects and registers again after the api drops the socket", async () => {
    const api = fakeApi({ heartbeatMs: 1_000 });
    const client = connectRunner({
      apiUrl: api.url,
      token: "prt_ok",
      reconnect: { minMs: 10, maxMs: 20 },
    });
    await client.registered();
    expect(api.registrations.length).toBe(1);
    api.socket().close(1012, "api restarting");
    await api.waitFor(() => api.registrations.length >= 2, 5_000);
    await api.waitFor(() => client.status === "online", 5_000);
    await client.close();
  });
});
