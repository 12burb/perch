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
 * Windows only: tao's `run_return`, which the addon's pumpEvents() uses there, leaves the loop through
 * `GetMessageW` after the exit flag is set and posts nothing to wake itself, so a pump returns only
 * when some unrelated message arrives; an idle queue blocks JavaScript indefinitely (seen in CI: the
 * window sat idle and no timer ever fired). A thread timer with no window posts WM_TIMER to the queue
 * every 16 ms, which DispatchMessageW ignores and which wakes every pump within a frame.
 */
async function keepMessageQueueBusy(trace: (line: string) => void): Promise<() => void> {
  if (process.platform !== "win32") return () => {};
  const { dlopen, FFIType } = await import("bun:ffi");
  const user32 = dlopen("user32.dll", {
    SetTimer: { args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
    KillTimer: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  });
  const id = user32.symbols.SetTimer(null, 0, 16, null);
  trace(`windows: thread timer ${id} keeps the message queue busy`);
  return () => {
    user32.symbols.KillTimer(null, id);
    user32.close();
  };
}

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

export async function openWindow(options: OpenWindowOptions): Promise<void> {
  const trace = options.trace ?? (() => {});
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
  const stopQueueTimer = await keepMessageQueueBusy(trace);
  return new Promise<void>((resolve) => {
    let done = false;
    let ticks = 0;
    let loadStarted = false;
    let navigated = false;
    const finish = (why: string) => {
      if (done) return;
      done = true;
      trace(`closing: ${why}`);
      clearInterval(pump);
      clearInterval(liveness);
      clearTimeout(retry);
      stopQueueTimer();
      try {
        app.exit();
      } catch {
        // The loop already reported the app gone; exit after that is best effort.
      }
      resolve();
    };
    // The documented equivalent of app.run(): pump the OS queue from a timer; false means the last
    // window closed.
    const pump = setInterval(() => {
      ticks += 1;
      if (!app.pumpEvents()) finish("the event loop reported exit");
      else if (ticks === 1) trace("event loop pumping");
    }, 16);
    // WebView2 sometimes drops the navigation requested at creation (seen on Windows: the window sits
    // blank until a later loadUrl). One retry after 1.5 s costs nothing where the first one worked.
    const retry = setTimeout(() => {
      if (done || navigated || loadStarted) return;
      trace(`no navigation yet: loading ${options.url} again`);
      webview.loadUrl(options.url);
    }, 1_500);
    // With a trace: a liveness line every 5 s, and one more re-navigation after 10 s.
    const liveness = setInterval(() => {
      if (!options.trace) return;
      trace(`alive: ${ticks} ticks, visible=${win.isVisible()}, url=${webview.url() ?? "none"}`);
      if (!loadStarted && ticks > 0 && ticks * 16 >= 10_000 && ticks * 16 < 15_000) {
        trace(`nothing loaded yet: navigating again to ${options.url}`);
        webview.loadUrl(options.url);
      }
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
      trace(`page load finished ${url}`);
      options.onLoaded?.(url);
      if (options.closeAfterLoad) finish("closeAfterLoad");
    });
  });
}
