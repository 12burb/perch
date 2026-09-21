/**
 * A picture of a page the dev server is serving (spec §5.6 "Screenshot via headless Chromium in the
 * runner"; task 2.16).
 *
 * Headless Chromium is driven directly rather than through a library: `--screenshot` is what the
 * browser is for, and a runner that already has to ship a browser for the agent's eyes should not
 * also ship a second way of asking it for a picture (ADR-0108). Which browser is found in the
 * environment, so a laptop runner uses whatever Playwright already installed there.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "./env.ts";

export class NoBrowser extends Error {
  constructor() {
    super("this runner has no headless browser; install Chromium or set PERCH_CHROMIUM");
    this.name = "NoBrowser";
  }
}

/**
 * Where Playwright keeps the browsers it downloads. Its own rule: `PLAYWRIGHT_BROWSERS_PATH` wins,
 * otherwise a per-platform cache directory. (`0` means "inside node_modules", which is a layout
 * this does not go looking through.)
 */
function playwrightRoot(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | null {
  const named = env.PLAYWRIGHT_BROWSERS_PATH;
  if (named) return named === "0" ? null : named;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (platform === "win32")
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ms-playwright");
  if (platform === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  return join(home, ".cache", "ms-playwright");
}

/**
 * Where the executable sits inside one of those directories. Playwright's layout is per platform
 * and has moved before — linux-x64 is a Chrome-for-Testing build under `chrome-linux64` while
 * linux-arm64 is its own build under `chrome-linux` — so every layout it has used is a candidate
 * and the one that exists wins. Guessing a single path is what broke CI once already.
 */
function insideBrowserDir(platform: NodeJS.Platform): string[] {
  if (platform === "win32") return ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"];
  if (platform === "darwin")
    return [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    ];
  return ["chrome-linux64/chrome", "chrome-linux/chrome"];
}

/** And where the headless shell sits, which Playwright lays out differently again. */
function shellInside(platform: NodeJS.Platform): string[] {
  if (platform === "win32") return ["chrome-headless-shell-win64/chrome-headless-shell.exe"];
  if (platform === "darwin")
    return [
      "chrome-headless-shell-mac-arm64/chrome-headless-shell",
      "chrome-headless-shell-mac-x64/chrome-headless-shell",
    ];
  return ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"];
}

/** The `chromium-1194`-style directories under a root, newest revision first. */
function browserDirs(root: string, prefix: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    // No cache directory is the ordinary case on a machine that has never run Playwright.
    return [];
  }
  return names
    .filter((one) => one.startsWith(`${prefix}-`))
    .map((one) => ({ name: one, revision: Number(one.slice(prefix.length + 1)) }))
    .filter((one) => Number.isFinite(one.revision))
    .sort((a, b) => b.revision - a.revision)
    .map((one) => join(root, one.name));
}

/** Every browser Playwright has downloaded here, the full ones before the headless shells. */
function playwrightBrowsers(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): { full: string[]; shells: string[] } {
  const root = playwrightRoot(env, platform);
  if (!root) return { full: [], shells: [] };
  const paths = (dirs: string[], insides: string[]): string[] =>
    dirs.flatMap((dir) => insides.map((inside) => join(dir, ...inside.split("/"))));
  return {
    full: paths(browserDirs(root, "chromium"), insideBrowserDir(platform)),
    shells: paths(browserDirs(root, "chromium_headless_shell"), shellInside(platform)),
  };
}

/**
 * The candidates, nearest first: what the operator named, what Playwright put there, what the
 * machine has installed, and last the headless shell — which speaks the same protocol but is not
 * what anyone means by "the browser on this machine".
 */
export function browserCandidates(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string[] {
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
  const downloaded = playwrightBrowsers(env, platform);
  return [...named, ...downloaded.full, ...known, ...downloaded.shells];
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
    { stdout: "ignore", stderr: "pipe", env: childEnv() },
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
