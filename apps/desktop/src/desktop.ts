/**
 * The Perch desktop app (ADR-0063): laptop mode in a native window. `perch-desktop` boots api + web +
 * the in-process runner on PGlite under ~/.perch on a fixed port, so the origin, and with it the session
 * cookie and passkeys, survive restarts; attaches to a Perch already listening there; or opens a team
 * instance with --url. Closing the window stops the server. Everything native lives in window.ts and
 * arrives through `DesktopDeps`, so this file is testable without a display.
 */
import { parseArgs } from "node:util";

export const DEFAULT_PORT = 47160;
export const WINDOW_TITLE = "Perch";
export const DEFAULT_LOG_LEVEL = "warn";

export const HELP = `perch-desktop [options]

Perch on this machine, in its own window: api, web, and the in-process runner on PGlite under
~/.perch, on a fixed port so sign-ins survive restarts. Closing the window stops the server.

Options:
  --url <url>         open an existing Perch (a team instance) instead of running laptop mode
  --port <n>          laptop-mode port (default: ${DEFAULT_PORT}); a Perch already listening there is reused
  --data-dir <path>   PGlite, files, the master key, and the window's browsing data (default: ~/.perch)
  --log-level <lvl>   trace|debug|info|warn|error|fatal|silent (default: ${DEFAULT_LOG_LEVEL})
  --check             load the platform webview and exit (for doctor and CI)
  -h, --help          show this help`;

export type DesktopArgs =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "check" }
  | { kind: "open"; url: string; dataDir?: string }
  | { kind: "laptop"; port: number; dataDir?: string; logLevel: string };

export function parseDesktopArgs(argv: string[]): DesktopArgs {
  let values: {
    url?: string;
    port?: string;
    "data-dir"?: string;
    "log-level"?: string;
    check?: boolean;
    help?: boolean;
  };
  try {
    values = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        port: { type: "string" },
        "data-dir": { type: "string" },
        "log-level": { type: "string" },
        check: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }).values;
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (values.help) return { kind: "help" };
  if (values.check) return { kind: "check" };
  if (values.url !== undefined) {
    if (!/^https?:\/\//.test(values.url)) {
      return { kind: "error", message: `--url must start with http:// or https://: ${values.url}` };
    }
    return { kind: "open", url: values.url.replace(/\/$/, ""), dataDir: values["data-dir"] };
  }
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { kind: "error", message: `bad port: ${values.port}` };
  }
  return {
    kind: "laptop",
    port,
    dataDir: values["data-dir"],
    logLevel: values["log-level"] ?? DEFAULT_LOG_LEVEL,
  };
}

/** The window's origin for laptop mode: localhost (a valid passkey RP ID, unlike 127.0.0.1). */
export function laptopUrl(port: number): string {
  return `http://localhost:${port}`;
}

/** True when a Perch api answers at the origin (any mode); false for nothing, or something else. */
export async function probePerch(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: unknown; mode?: unknown };
    return body.status === "ok" && typeof body.mode === "string";
  } catch {
    return false;
  }
}

export type WindowRequest = { url: string; title: string; dataDir: string };

export type LaptopHandle = { url: string; dataDir: string; stop(): Promise<void> };

export type DesktopDeps = {
  startLaptop: (options: {
    dataDir?: string;
    port: number;
    host: string;
    publicUrl: string;
    logLevel: string;
  }) => Promise<LaptopHandle>;
  /** Opens the window and resolves when it has been closed. */
  openWindow: (request: WindowRequest) => Promise<void>;
  /** Loads the platform webview; throws when it cannot. */
  checkWebview: () => Promise<string>;
  isPerchAt: (url: string) => Promise<boolean>;
  dataDirFrom: (flag?: string) => string;
  log: (line: string) => void;
  error: (line: string) => void;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runDesktop(argv: string[], deps: DesktopDeps): Promise<number> {
  const args = parseDesktopArgs(argv);
  switch (args.kind) {
    case "help":
      deps.log(HELP);
      return 0;
    case "error":
      deps.error(`${args.message}\n\n${HELP}`);
      return 2;
    case "check":
      try {
        deps.log(`webview: ${await deps.checkWebview()}`);
        return 0;
      } catch (error) {
        deps.error(`webview: ${message(error)}`);
        return 1;
      }
    case "open":
      await deps.openWindow({
        url: args.url,
        title: WINDOW_TITLE,
        dataDir: deps.dataDirFrom(args.dataDir),
      });
      return 0;
    case "laptop": {
      const url = laptopUrl(args.port);
      const dataDir = deps.dataDirFrom(args.dataDir);
      if (await deps.isPerchAt(url)) {
        // A second launch, or `perch dev --port` on the same port: one server, one more window.
        deps.log(`perch-desktop: attaching to the Perch already at ${url}`);
        await deps.openWindow({ url, title: WINDOW_TITLE, dataDir });
        return 0;
      }
      let laptop: LaptopHandle;
      try {
        laptop = await deps.startLaptop({
          dataDir: args.dataDir,
          port: args.port,
          host: "127.0.0.1",
          publicUrl: url,
          logLevel: args.logLevel,
        });
      } catch (error) {
        deps.error(
          `perch-desktop: laptop mode could not start at ${url}: ${message(error)}\n` +
            "  Is another Perch using the data directory (perch dev)? Close it, or pass --data-dir.",
        );
        return 1;
      }
      deps.log(`perch-desktop: ${laptop.url}\n  data: ${laptop.dataDir}`);
      try {
        await deps.openWindow({ url: laptop.url, title: WINDOW_TITLE, dataDir: laptop.dataDir });
      } finally {
        await laptop.stop();
      }
      return 0;
    }
  }
}
