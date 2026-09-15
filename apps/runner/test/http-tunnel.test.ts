import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeTunnelFrame, encodeTunnelFrame } from "@perch/events";
import { HttpTunnel } from "../src/http-tunnel.ts";
import { streamOverSocket } from "../src/streams.ts";

/**
 * Task 1.19, ADR-0091: the runner's half of the preview tunnel over a real socket — the same shape
 * `perch runner connect` has, where the stream is a client WebSocket the runner opened.
 *
 * A client socket in Bun discards whatever it has not written yet the moment `close()` is called,
 * so a runner that hangs up on its own answer loses the tail of it — a page arriving short, with
 * no error anywhere to say so. The runner says `end` and leaves the hang-up to the api.
 */

const BODY = "a".repeat(200_000);

let dev: ReturnType<typeof Bun.serve> | null = null;
let api: ReturnType<typeof Bun.serve> | null = null;
let devPort = 0;

const sessions = new Map<string, Session>();

/** What the stand-in api collected from one round trip through the tunnel. */
type Answer = {
  status: number;
  bytes: number;
  /** Who hung up once the whole answer had arrived. */
  hungUpBy: "api" | "runner";
};

type Session = {
  status: number;
  bytes: number;
  settle: (answer: Answer) => void;
};

/** Long enough for a hang-up on loopback to have arrived, short enough to be a test. */
const GRACE_MS = 500;

beforeAll(() => {
  // The "laptop's" dev server: it echoes what it is given, streaming as it goes.
  dev = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => new Response(request.body, { headers: { "content-type": "text/plain" } }),
  });
  devPort = dev.port as number;

  // The stand-in api: sends the request body, collects the answer, and hangs up on `end`.
  api = Bun.serve<Session>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      const session = sessions.get(new URL(request.url).pathname.split("/").pop() ?? "");
      if (!session) return new Response("no such stream", { status: 404 });
      if (server.upgrade(request, { data: session })) return undefined as unknown as Response;
      return new Response("expected a websocket", { status: 426 });
    },
    websocket: {
      open(ws) {
        // The body in 16 KiB chunks, then the end marker, exactly as the api's side sends it.
        const bytes = new TextEncoder().encode(BODY);
        for (let at = 0; at < bytes.length; at += 16_384) {
          ws.send(encodeTunnelFrame({ kind: "bytes", data: bytes.subarray(at, at + 16_384) }));
        }
        ws.send(encodeTunnelFrame({ kind: "end" }));
      },
      async message(ws, raw) {
        const frame = decodeTunnelFrame(String(raw));
        if (!frame) return;
        const session = ws.data;
        if (frame.kind === "head") session.status = frame.status;
        if (frame.kind === "bytes") session.bytes += frame.data.byteLength;
        if (frame.kind !== "end") return;
        // The answer is complete. A runner that hangs up on it has closed by now; one that leaves
        // the hang-up to the api is still here, and the api is the side that may close safely.
        await Bun.sleep(GRACE_MS);
        if (ws.readyState !== 1) return;
        session.settle({ status: session.status, bytes: session.bytes, hungUpBy: "api" });
        ws.close(1000, "done");
      },
      close(ws) {
        // Reached first only when the runner hung up on its own answer.
        ws.data.settle({ status: ws.data.status, bytes: ws.data.bytes, hungUpBy: "runner" });
      },
    },
  });
});

afterAll(() => {
  dev?.stop(true);
  api?.stop(true);
});

/** One round trip: the runner's tunnel against the stand-in api, over a real client socket. */
async function roundTrip(): Promise<Answer> {
  let settle: (answer: Answer) => void = () => {};
  const answered = new Promise<Answer>((resolve) => {
    settle = resolve;
  });
  const tunnel = new HttpTunnel({
    streams: {
      open: (token) =>
        new Promise((resolve, reject) => {
          sessions.set(token, { status: 0, bytes: 0, settle });
          const ws = new WebSocket(`${api?.url.href.replace("http", "ws")}stream/${token}`);
          const stream = streamOverSocket(ws);
          ws.addEventListener("open", () => resolve(stream), { once: true });
          ws.addEventListener("error", () => reject(new Error("stream socket failed")), {
            once: true,
          });
        }),
    },
  });
  await tunnel.open({
    workspace_id: crypto.randomUUID(),
    user_id: crypto.randomUUID(),
    cap: "a capability token the api minted",
    port: devPort,
    path: "/echo",
    method: "POST",
    headers: [["content-type", "text/plain"]],
  });
  return answered;
}

describe("the runner's tunnel over a real socket (task 1.19)", () => {
  test("a 200 KB answer comes back whole, and the api is the one that hangs up", async () => {
    const answer = await roundTrip();
    expect(answer.status).toBe(200);
    expect(answer.bytes).toBe(BODY.length);
    expect(answer.hungUpBy).toBe("api");
  }, 30_000);
});
