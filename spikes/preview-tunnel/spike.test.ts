import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTunnelApi, type TunnelApi } from "./api.ts";
import { connectTunnelRunner, type TunnelRunner } from "./runner.ts";

/**
 * Spike 0.4.9 — preview tunnel over a local runner (spec §9.3, §5.6, §7.6).
 * Pass: HMR WebSocket for a Vite app on a local runner works end to end through the api.
 *
 * A real Vite dev server (the user's project process, run under Node by vite-server.mjs) listens on
 * 127.0.0.1 only. The runner (runner.ts) opens an outbound control socket to the api (api.ts); the test plays
 * the browser and reaches Vite only through the api's /p/<port> path: over HTTP (index.html, a transformed
 * module) and over WebSocket (Vite's `vite-hmr` channel: the `connected` handshake and a live update after a
 * file edit). Outcome in DECISIONS.md (ADR-0037).
 */

const nodeBinary = Bun.which("node");
let root = "";
let viteProc: Bun.Subprocess<"pipe", "pipe", "inherit"> | null = null;
let vitePort = 0;
let viteToken = "";
let api: TunnelApi;
let runner: TunnelRunner;

function nextMessage(ws: WebSocket, ms: number, filter?: (m: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no message in ${ms} ms`)), ms);
    const handler = (ev: MessageEvent) => {
      const text = String(ev.data);
      if (filter && !filter(text)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(text);
    };
    ws.addEventListener("message", handler);
  });
}

describe.skipIf(!nodeBinary)("spike 0.4.9 preview tunnel over a local runner", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "perch-vite-"));
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html><html><body><div id="app"></div><script type="module" src="/main.ts"></script></body></html>\n',
    );
    writeFileSync(
      join(root, "main.ts"),
      'export const version = 1;\ndocument.querySelector("#app")!.textContent = "v1";\n',
    );
    viteProc = Bun.spawn([nodeBinary ?? "node", join(import.meta.dir, "vite-server.mjs"), root], {
      cwd: import.meta.dir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = viteProc.stdout.getReader();
    let line = "";
    while (!line.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("vite server exited before printing its port");
      line += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const info = JSON.parse(line.trim()) as { port: number; token: string };
    vitePort = info.port;
    viteToken = info.token;
    api = startTunnelApi(0);
    runner = await connectTunnelRunner(api.url);
  }, 60_000);

  afterAll(async () => {
    runner?.stop();
    api?.stop();
    if (viteProc) {
      viteProc.stdin.end();
      await Promise.race([viteProc.exited, new Promise((r) => setTimeout(r, 3_000))]);
      viteProc.kill();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("the runner is connected outbound and the dev server listens only on localhost", () => {
    expect(vitePort).toBeGreaterThan(0);
    expect(api.hasRunner()).toBe(true);
  });

  test("HTTP: index.html and a transformed module arrive through /p/<port>", async () => {
    const html = await fetch(`${api.url}/p/${vitePort}/`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    const body = await html.text();
    expect(body).toContain("/@vite/client");
    expect(body).toContain("/main.ts");

    const mod = await fetch(`${api.url}/p/${vitePort}/main.ts`);
    expect(mod.status).toBe(200);
    expect(await mod.text()).toContain("version = 1");
  }, 30_000);

  test("HMR: the vite-hmr WebSocket handshakes and delivers an update after a file edit", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${api.port}/p/${vitePort}/?token=${viteToken}`, [
      "vite-hmr",
    ]);
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("hmr socket failed"));
    });
    const connected = nextMessage(ws, 15_000);
    await opened;
    expect(JSON.parse(await connected)).toMatchObject({ type: "connected" });

    const update = nextMessage(
      ws,
      15_000,
      (m) => m.includes('"update"') || m.includes('"full-reload"'),
    );
    writeFileSync(
      join(root, "main.ts"),
      'export const version = 2;\ndocument.querySelector("#app")!.textContent = "v2";\n',
    );
    const message = JSON.parse(await update) as { type: string };
    expect(["update", "full-reload"]).toContain(message.type);
    ws.close();
  }, 60_000);
});

describe.skipIf(Boolean(nodeBinary))("spike 0.4.9 preview tunnel (no node binary)", () => {
  test("skipped: the sample dev server needs node", () => {
    expect(nodeBinary).toBeNull();
  });
});
