/**
 * The native window (ADR-0063): @webviewjs/webview drives the platform webview (WebView2 on Windows,
 * WebKit on macOS, WebKitGTK on Linux) from Bun through N-API. The addon is imported lazily so
 * --help and the unit tests never touch it, and the event loop is pumped from a timer so the in-process
 * server keeps serving while the window is open.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import iconRgba from "../assets/icon-128.rgba" with { type: "file" };
import type { WindowRequest } from "./desktop.ts";

export type OpenWindowOptions = WindowRequest & { width?: number; height?: number };

/** Without a menu, macOS gives the app neither Cmd+Q nor the Edit shortcuts inside the webview. */
const MAC_MENU = {
  items: [
    {
      label: "Perch",
      submenu: {
        items: [
          { role: "about" },
          { role: "separator" },
          { role: "hide" },
          { role: "hideothers" },
          { role: "showall" },
          { role: "separator" },
          { role: "quit" },
        ],
      },
    },
    {
      label: "Edit",
      submenu: {
        items: [
          { role: "undo" },
          { role: "redo" },
          { role: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectall" },
        ],
      },
    },
    {
      label: "Window",
      submenu: {
        items: [
          { role: "minimize" },
          { role: "maximize" },
          { role: "fullscreen" },
          { role: "separator" },
          { role: "close" },
        ],
      },
    },
  ],
};

/**
 * Loads the addon and the system webview it links; the message names the platform and the engine
 * version for --check (on Windows an empty version means no WebView2 runtime).
 */
export async function checkWebview(): Promise<string> {
  const mod = (await import("@webviewjs/webview")) as { getWebviewVersion?: () => string };
  let version = "";
  try {
    version = mod.getWebviewVersion?.() ?? "";
  } catch (error) {
    version = `unknown (${error instanceof Error ? error.message : String(error)})`;
  }
  return `${process.platform}-${process.arch} ok (@webviewjs/webview, engine ${version || "unknown"})`;
}

/** Where the window keeps cookies, storage, and cache: beside the rest of the laptop-mode data. */
export function browsingDataDir(dataDir: string): string {
  return join(dataDir, "desktop", "webview");
}

export type OpenedWindow = {
  /** The URL of the first finished page load; null where the shell cannot observe page loads. */
  loaded: string | null;
  /** Whether page-load events reach the shell on this platform (false on Windows). */
  pageEvents: boolean;
};

type Created = {
  app: import("@webviewjs/webview").Application;
  win: import("@webviewjs/webview").BrowserWindow;
  webview: import("@webviewjs/webview").Webview;
};

async function createWindow(
  options: OpenWindowOptions,
  trace: (line: string) => void,
): Promise<Created> {
  const { Application } = await import("@webviewjs/webview");
  trace("addon loaded");
  // The WebContext owns cookies, storage, and cache for every engine (on Windows it is the WebView2
  // user data folder, which must be writable, so never beside the executable).
  const dataDirectory = browsingDataDir(options.dataDir);
  mkdirSync(dataDirectory, { recursive: true });
  const app = new Application();
  trace("application created");
  if (process.platform === "darwin") app.setMenu(MAC_MENU);
  const win = app.createBrowserWindow({
    title: options.title,
    width: options.width ?? 1280,
    height: options.height ?? 800,
  });
  trace("window created");
  if (process.platform !== "darwin") {
    // The .app bundle carries the macOS icon; elsewhere the window shows the embedded pixels.
    win.setWindowIcon(await Bun.file(iconRgba).bytes(), 128, 128);
    trace("window icon set");
  }
  const context = app.createWebContext({ dataDirectory });
  trace(`web context at ${dataDirectory}`);
  const webview = win.createWebview({ url: options.url, webContext: context });
  trace(`webview created for ${options.url}`);
  return { app, win, webview };
}

/**
 * Windows: the native run loop on this thread (the server runs on a worker thread, laptop-worker.ts).
 * The addon's timer-driven pump is unreliable here: tao's `run_return` only leaves its loop when a
 * message arrives after the exit flag is set, and the internal paint that carries MainEventsCleared
 * can be starved, which left a blank window and a frozen JavaScript thread in CI. `runSync()` returns
 * when the last window has been destroyed. Page events cannot reach JavaScript meanwhile; a smoke
 * closes the window from a helper thread after `closeAfterMs`.
 */
async function openWindowNative(
  options: OpenWindowOptions,
  trace: (line: string) => void,
): Promise<OpenedWindow> {
  const { app, win } = await createWindow(options, trace);
  let closer: Worker | null = null;
  if (options.closeAfterLoad) {
    closer = new Worker(new URL("./closer-worker.js", import.meta.url));
    const afterMs = options.closeAfterMs ?? 8_000;
    closer.postMessage({ hwnd: win.getNativeHandleAnyThread().toString(), afterMs });
    trace(`smoke: the window closes after ${afterMs} ms`);
  }
  trace("entering the native run loop");
  app.runSync();
  trace("native run loop returned: the window closed");
  closer?.terminate();
  return { loaded: null, pageEvents: false };
}

/** macOS and Linux: the addon's timer-driven pump, so the in-process server keeps serving. */
async function openWindowPumped(
  options: OpenWindowOptions,
  trace: (line: string) => void,
): Promise<OpenedWindow> {
  const { app, win, webview } = await createWindow(options, trace);
  return new Promise<OpenedWindow>((resolve) => {
    let done = false;
    let ticks = 0;
    let loadStarted = false;
    let navigated = false;
    let loaded: string | null = null;
    const finish = (why: string) => {
      if (done) return;
      done = true;
      trace(`closing: ${why}`);
      clearInterval(pump);
      clearInterval(liveness);
      clearTimeout(retry);
      try {
        app.exit();
      } catch {
        // The loop already reported the app gone; exit after that is best effort.
      }
      resolve({ loaded, pageEvents: true });
    };
    // The documented equivalent of app.run(): pump the OS queue from a timer; false means the last
    // window closed.
    const pump = setInterval(() => {
      ticks += 1;
      if (!app.pumpEvents()) finish("the event loop reported exit");
      else if (ticks === 1) trace("event loop pumping");
    }, 16);
    // A webview that dropped the navigation requested at creation gets one more loadUrl after 1.5 s.
    const retry = setTimeout(() => {
      if (done || navigated || loadStarted) return;
      trace(`no navigation yet: loading ${options.url} again`);
      webview.loadUrl(options.url);
    }, 1_500);
    // With a trace: a liveness line every 5 s.
    const liveness = setInterval(() => {
      if (!options.trace) return;
      trace(`alive: ${ticks} ticks, visible=${win.isVisible()}, url=${webview.url() ?? "none"}`);
    }, 5_000);
    win.on("close", () => finish("window closed"));
    webview.on("page-load-started", (event) => {
      loadStarted = true;
      trace(`page load started ${event.url ?? ""}`);
    });
    webview.on("navigation", (event) => {
      navigated = true;
      trace(`navigation ${event.url ?? ""}`);
    });
    webview.on("page-load-finished", (event) => {
      const url = event.url ?? webview.url() ?? "";
      loaded ??= url;
      trace(`page load finished ${url}`);
      options.onLoaded?.(url);
      if (options.closeAfterLoad) finish("closeAfterLoad");
    });
  });
}

/** Opens the window and resolves when it has been closed. */
export function openWindow(options: OpenWindowOptions): Promise<OpenedWindow> {
  const trace = options.trace ?? (() => {});
  return process.platform === "win32"
    ? openWindowNative(options, trace)
    : openWindowPumped(options, trace);
}
