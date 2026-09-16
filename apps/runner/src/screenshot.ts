/**
 * A picture of a page the dev server is serving (spec §5.6 "Screenshot via headless Chromium in the
 * runner"; task 2.16).
 *
 * Headless Chromium is driven directly rather than through a library: `--screenshot` is what the
 * browser is for, and a runner that already has to ship a browser for the agent's eyes should not
 * also ship a second way of asking it for a picture (ADR-0108). Which browser is found in the
 * environment, so a laptop runner uses whatever Playwright already installed there.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class NoBrowser extends Error {
  constructor() {
    super("this runner has no headless browser; install Chromium or set PERCH_CHROMIUM");
    this.name = "NoBrowser";
  }
}

/** The candidates, nearest first: what the operator named, what Playwright put there, the PATH. */
export function browserCandidates(env: Record<string, string | undefined>): string[] {
  const named = [env.PERCH_CHROMIUM, env.PLAYWRIGHT_CHROMIUM_EXECUTABLE].filter(
    (one): one is string => Boolean(one),
  );
  const known = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return [...named, ...known];
}

export function findBrowser(env: Record<string, string | undefined> = process.env): string | null {
  for (const candidate of browserCandidates(env)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export type ScreenshotInput = {
  port: number;
  path: string;
  width?: number | undefined;
  height?: number | undefined;
};

/** One console line the page wrote, with the level the page meant. */
export type PageConsoleLine = { level: string; text: string };
/** A request the page made that did not come back. */
export type PageFailedRequest = { url: string; status: number };

export type VisitResult = {
  png: string;
  width: number;
  height: number;
  /** Everything the page logged, classified — an uncaught exception arrives as `error`. */
  console: PageConsoleLine[];
  failed: PageFailedRequest[];
};

type Pending = (message: Record<string, unknown>) => void;

/**
 * One page, visited (spec §5.6 "Screenshot via headless Chromium in the runner", and preflight's
 * "screenshot each, fail on console errors"; tasks 2.16, 3.21).
 *
 * Driven over the DevTools protocol rather than by `--screenshot`, because preflight needs a
 * verdict and not only a picture. Chromium's command-line logging writes `console.error` and an
 * uncaught exception at the same `INFO:CONSOLE` severity, so what a page thought was an error is
 * not recoverable from it; `Runtime.consoleAPICalled` says so exactly. Keeping both would be the
 * second way of asking a browser for the same thing that ADR-0108 declined to ship, so this is the
 * one way and `screenshot` asks it for the picture (ADR-0140).
 *
 * The browser is given nothing but the URL: no profile, no extensions, no network beyond the
 * machine it is on.
 */
export async function visit(
  input: ScreenshotInput,
  options: { browser?: string | undefined; timeoutMs?: number; settleMs?: number } = {},
): Promise<VisitResult> {
  const browser = options.browser ?? findBrowser();
  if (!browser) throw new NoBrowser();
  const width = input.width ?? 1280;
  const height = input.height ?? 800;
  const budget = options.timeoutMs ?? 30_000;
  const dir = mkdtempSync(join(tmpdir(), "perch-visit-"));
  const url = `http://127.0.0.1:${input.port}${input.path.startsWith("/") ? input.path : `/${input.path}`}`;

  const proc = Bun.spawn(
    [
      browser,
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}`,
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );

  let socket: WebSocket | null = null;
  try {
    const endpoint = await announced(proc, budget);
    const page = await pageSocketUrl(new URL(endpoint).host, budget);
    socket = new WebSocket(page);
    await opened(socket, budget);

    const lines: PageConsoleLine[] = [];
    const failed: PageFailedRequest[] = [];
    const pending = new Map<number, Pending>();
    let id = 0;
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (typeof message.id === "number") {
        pending.get(message.id)?.(message as Record<string, unknown>);
        pending.delete(message.id);
        return;
      }
      collect(message, lines, failed);
    };
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        socket?.send(JSON.stringify({ id: n, method, params }));
      });

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Log.enable");
    await send("Network.enable");
    await send("Page.navigate", { url });
    // The page is given a moment to finish being a page: a framework that renders on the client
    // has nothing on screen at load, and a picture of nothing is not a smoke test.
    await Bun.sleep(options.settleMs ?? 1_500);
    const shot = (await send("Page.captureScreenshot", { format: "png" })) as {
      result?: { data?: string };
    };
    const png = shot.result?.data ?? "";
    if (!png) throw new Error("the browser took no picture");
    return { png, width, height, console: lines, failed };
  } finally {
    socket?.close();
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A picture of one page, which is `visit` without the verdict (task 2.16). */
export async function screenshot(
  input: ScreenshotInput,
  options: { browser?: string | undefined; timeoutMs?: number } = {},
): Promise<{ png: string; width: number; height: number }> {
  const { png, width, height } = await visit(input, options);
  return { png, width, height };
}

/** What the page said, out of the events that say it. */
export function collect(
  message: { method?: string; params?: Record<string, unknown> },
  lines: PageConsoleLine[],
  failed: PageFailedRequest[],
): void {
  if (message.method === "Runtime.consoleAPICalled") {
    const params = message.params as { type?: string; args?: { value?: unknown }[] } | undefined;
    lines.push({
      level: params?.type ?? "log",
      text: (params?.args ?? []).map((one) => String(one.value ?? "")).join(" "),
    });
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    const params = message.params as
      | { exceptionDetails?: { text?: string; exception?: { description?: string } } }
      | undefined;
    const details = params?.exceptionDetails;
    // An uncaught exception is an error whatever the page thought it was doing.
    lines.push({
      level: "error",
      text: details?.exception?.description ?? details?.text ?? "an exception",
    });
    return;
  }
  if (message.method === "Network.responseReceived") {
    const params = message.params as { response?: { url?: string; status?: number } } | undefined;
    const status = params?.response?.status ?? 0;
    if (status >= 400) failed.push({ url: params?.response?.url ?? "", status });
  }
}

/** `DevTools listening on ws://…`, which the browser writes to stderr once it is up. */
async function announced(proc: { stderr: ReadableStream<Uint8Array> }, budget: number) {
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  const stop = Date.now() + budget;
  let seen = "";
  try {
    while (Date.now() < stop) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(seen)?.[1];
      if (found) return found;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  throw new Error("the browser did not start in time");
}

/** The page's own socket: the endpoint the browser announces has no page on it. */
async function pageSocketUrl(host: string, budget: number): Promise<string> {
  const stop = Date.now() + budget;
  while (Date.now() < stop) {
    try {
      const targets = (await (await fetch(`http://${host}/json/list`)).json()) as {
        type?: string;
        webSocketDebuggerUrl?: string;
      }[];
      const page = targets.find((one) => one.type === "page")?.webSocketDebuggerUrl;
      if (page) return page;
    } catch {
      // Still coming up.
    }
    await Bun.sleep(50);
  }
  throw new Error("the browser opened no page");
}

function opened(socket: WebSocket, budget: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the browser did not answer in time")), budget);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("the browser refused the connection"));
    };
  });
}
