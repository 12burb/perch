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

export type OpenWindowOptions = WindowRequest & {
  width?: number;
  height?: number;
  /** Called after every page load with the loaded URL. */
  onLoaded?: (url: string) => void;
  /** Close the window after the first page load (the smoke test). */
  closeAfterLoad?: boolean;
};

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

/** Loads the addon and the system webview it links; the message names the platform for --check. */
export async function checkWebview(): Promise<string> {
  await import("@webviewjs/webview");
  return `${process.platform}-${process.arch} ok (@webviewjs/webview)`;
}

/** Where the window keeps cookies, storage, and cache: beside the rest of the laptop-mode data. */
export function browsingDataDir(dataDir: string): string {
  return join(dataDir, "desktop", "webview");
}

export async function openWindow(options: OpenWindowOptions): Promise<void> {
  const { Application } = await import("@webviewjs/webview");
  const dataDirectory = browsingDataDir(options.dataDir);
  mkdirSync(dataDirectory, { recursive: true });
  // WebView2 reads its user data folder from the environment; the WebContext covers the other engines.
  if (process.platform === "win32" && !process.env.WEBVIEW2_USER_DATA_FOLDER) {
    process.env.WEBVIEW2_USER_DATA_FOLDER = dataDirectory;
  }
  const app = new Application();
  if (process.platform === "darwin") app.setMenu(MAC_MENU);
  const win = app.createBrowserWindow({
    title: options.title,
    width: options.width ?? 1280,
    height: options.height ?? 800,
  });
  if (process.platform !== "darwin") {
    // The .app bundle carries the macOS icon; elsewhere the window shows the embedded pixels.
    win.setWindowIcon(await Bun.file(iconRgba).bytes(), 128, 128);
  }
  const context = app.createWebContext({ dataDirectory });
  const webview = win.createWebview({ url: options.url, webContext: context });
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(pump);
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
      if (!app.pumpEvents()) finish();
    }, 16);
    win.on("close", finish);
    webview.on("page-load-finished", (event) => {
      options.onLoaded?.(event.url ?? webview.url() ?? "");
      if (options.closeAfterLoad) finish();
    });
  });
}
