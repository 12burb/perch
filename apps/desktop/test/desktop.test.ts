import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PORT,
  type DesktopDeps,
  HELP,
  laptopUrl,
  parseDesktopArgs,
  probePerch,
  runDesktop,
} from "../src/desktop.ts";
import { browsingDataDir, checkWebview } from "../src/window.ts";

/**
 * The desktop app (ADR-0063). The flow is checked with fakes (no display needed); the native layer
 * with the real addon: --check always, and a real window on laptop mode wherever a display exists.
 * PERCH_DESKTOP_NATIVE=1 (CI) makes both native tests mandatory instead of skipping without the
 * platform libraries or a display.
 */

describe("perch-desktop arguments", () => {
  test("defaults to laptop mode on the fixed port with a quiet log", () => {
    expect(parseDesktopArgs([])).toEqual({
      kind: "laptop",
      port: DEFAULT_PORT,
      dataDir: undefined,
      logLevel: "warn",
    });
    expect(laptopUrl(DEFAULT_PORT)).toBe("http://localhost:47160");
  });

  test("--url opens a team instance; --check, --help, and bad input are recognised", () => {
    expect(parseDesktopArgs(["--url", "https://perch.example.com/"])).toEqual({
      kind: "open",
      url: "https://perch.example.com",
      dataDir: undefined,
    });
    expect(parseDesktopArgs(["--url", "perch.example.com"]).kind).toBe("error");
    expect(parseDesktopArgs(["--check"])).toEqual({ kind: "check" });
    expect(parseDesktopArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseDesktopArgs(["--port", "99999"]).kind).toBe("error");
    expect(parseDesktopArgs(["--bogus"]).kind).toBe("error");
    expect(
      parseDesktopArgs(["--port", "4000", "--data-dir", "/tmp/x", "--log-level", "info"]),
    ).toEqual({ kind: "laptop", port: 4000, dataDir: "/tmp/x", logLevel: "info" });
  });

  test("the internal flags: --serve accepts port 0; --close-window takes a handle and a delay", () => {
    expect(
      parseDesktopArgs(["--serve", "--port", "0", "--public-url", "http://localhost:0"]),
    ).toEqual({
      kind: "serve",
      port: 0,
      dataDir: undefined,
      logLevel: "warn",
      publicUrl: "http://localhost:0",
    });
    expect(parseDesktopArgs(["--port", "0"]).kind).toBe("error");
    expect(parseDesktopArgs(["--close-window", "132466", "--after", "500"])).toEqual({
      kind: "close-window",
      hwnd: "132466",
      afterMs: 500,
    });
    expect(parseDesktopArgs(["--close-window", "nope"]).kind).toBe("error");
  });
});

describe("probePerch", () => {
  const fetchLike = (handler: () => Promise<Response>) =>
    (() => handler()) as unknown as typeof fetch;

  test("true only for a Perch api answering /api/health", async () => {
    expect(
      await probePerch(
        "http://localhost:1",
        fetchLike(async () => Response.json({ status: "ok", mode: "laptop" })),
      ),
    ).toBe(true);
    expect(
      await probePerch(
        "http://localhost:1",
        fetchLike(async () => new Response("<html>", { status: 200 })),
      ),
    ).toBe(false);
    expect(
      await probePerch(
        "http://localhost:1",
        fetchLike(async () => {
          throw new Error("ECONNREFUSED");
        }),
      ),
    ).toBe(false);
  });
});

type Calls = { log: string[]; error: string[]; windows: Array<{ url: string; dataDir: string }> };

function fakeDeps(overrides: Partial<DesktopDeps> = {}): { deps: DesktopDeps; calls: Calls } {
  const calls: Calls = { log: [], error: [], windows: [] };
  const deps: DesktopDeps = {
    startLaptop: async (o) => ({
      url: o.publicUrl,
      dataDir: o.dataDir ?? "/home/x/.perch",
      stop: async () => {
        calls.log.push("stopped");
      },
    }),
    openWindow: async (w) => {
      calls.windows.push({ url: w.url, dataDir: w.dataDir });
      return { loaded: `${w.url}/`, pageEvents: true };
    },
    checkWebview: async () => "test-platform ok",
    isPerchAt: async () => false,
    dataDirFrom: (flag) => flag ?? "/home/x/.perch",
    tempDir: () => "/tmp/perch-smoke",
    holdUntilReleased: async () => {
      calls.log.push("released");
    },
    postWindowClose: async (hwnd, afterMs) => {
      calls.log.push(`close ${hwnd} after ${afterMs}`);
    },
    log: (line) => calls.log.push(line),
    error: (line) => calls.error.push(line),
    ...overrides,
  };
  return { deps, calls };
}

describe("perch-desktop flow", () => {
  test("boots laptop mode on the fixed localhost origin, opens the window, stops on close", async () => {
    const started: string[] = [];
    const { deps, calls } = fakeDeps({
      startLaptop: async (o) => {
        started.push(`${o.host} ${o.port} ${o.publicUrl} ${o.logLevel}`);
        return {
          url: o.publicUrl,
          dataDir: "/data",
          stop: async () => void calls.log.push("stopped"),
        };
      },
    });
    expect(await runDesktop([], deps)).toBe(0);
    expect(started).toEqual(["127.0.0.1 47160 http://localhost:47160 warn"]);
    expect(calls.windows).toEqual([{ url: "http://localhost:47160", dataDir: "/data" }]);
    expect(calls.log.at(-1)).toBe("stopped");
  });

  test("attaches to a Perch already on the port instead of booting a second one", async () => {
    let booted = false;
    const { deps, calls } = fakeDeps({
      isPerchAt: async (url) => url === "http://localhost:47160",
      startLaptop: async () => {
        booted = true;
        throw new Error("should not boot");
      },
    });
    expect(await runDesktop([], deps)).toBe(0);
    expect(booted).toBe(false);
    expect(calls.windows).toEqual([{ url: "http://localhost:47160", dataDir: "/home/x/.perch" }]);
    expect(calls.log[0]).toContain("attaching");
  });

  test("--url opens a window on a team instance without a server", async () => {
    let booted = false;
    const { deps, calls } = fakeDeps({
      startLaptop: async () => {
        booted = true;
        throw new Error("should not boot");
      },
    });
    expect(await runDesktop(["--url", "https://perch.example.com"], deps)).toBe(0);
    expect(booted).toBe(false);
    expect(calls.windows).toEqual([
      { url: "https://perch.example.com", dataDir: "/home/x/.perch" },
    ]);
  });

  test("--smoke boots a throwaway laptop mode, closes after the first load, and reports", async () => {
    const { deps, calls } = fakeDeps({
      startLaptop: async (o) => {
        expect(o.port).toBe(0);
        expect(o.dataDir).toBe("/tmp/perch-smoke");
        return {
          url: "http://127.0.0.1:54321",
          dataDir: o.dataDir ?? "",
          stop: async () => void calls.log.push("stopped"),
        };
      },
      openWindow: async (w) => {
        expect(w.closeAfterLoad).toBe(true);
        w.trace?.("window created");
        return { loaded: `${w.url}/setup`, pageEvents: true };
      },
    });
    expect(await runDesktop(["--smoke"], deps)).toBe(0);
    expect(calls.error.some((l) => l.includes("window created"))).toBe(true);
    const report = JSON.parse(calls.log.at(-1) ?? "{}") as { smoke: string; loaded: string };
    expect(report.smoke).toBe("ok");
    expect(report.loaded).toBe("http://127.0.0.1:54321/setup");
    expect(calls.log).toContain("stopped");

    // A shell that sees page loads must see one; a shell that cannot (Windows) passes on a clean close.
    const closedEarly = fakeDeps({
      startLaptop: async () => ({ url: "http://127.0.0.1:1", dataDir: "/x", stop: async () => {} }),
      openWindow: async () => ({ loaded: null, pageEvents: true }),
    });
    expect(await runDesktop(["--smoke"], closedEarly.deps)).toBe(3);
    const blind = fakeDeps({
      startLaptop: async () => ({ url: "http://127.0.0.1:1", dataDir: "/x", stop: async () => {} }),
      openWindow: async () => ({ loaded: null, pageEvents: false }),
    });
    expect(await runDesktop(["--smoke"], blind.deps)).toBe(0);
  });

  test("--serve reports the URL on one line, waits to be released, then stops", async () => {
    const { deps, calls } = fakeDeps();
    expect(
      await runDesktop(["--serve", "--port", "0", "--public-url", "http://localhost:0"], deps),
    ).toBe(0);
    const ready = JSON.parse(calls.log[0] ?? "{}") as { serve: string; url: string };
    expect(ready.serve).toBe("ready");
    expect(ready.url).toBe("http://localhost:0");
    expect(calls.log.slice(1)).toEqual(["released", "stopped"]);
    const { deps: closer, calls: closerCalls } = fakeDeps();
    expect(await runDesktop(["--close-window", "42", "--after", "10"], closer)).toBe(0);
    expect(closerCalls.log).toEqual(["close 42 after 10"]);
  });

  test("a boot failure is reported with a hint, not thrown; --check reports the native layer", async () => {
    const { deps, calls } = fakeDeps({
      startLaptop: async () => {
        throw new Error("EADDRINUSE");
      },
    });
    expect(await runDesktop([], deps)).toBe(1);
    expect(calls.error[0]).toContain("EADDRINUSE");
    expect(calls.error[0]).toContain("--data-dir");
    expect(calls.windows).toEqual([]);

    const ok = fakeDeps();
    expect(await runDesktop(["--check"], ok.deps)).toBe(0);
    expect(ok.calls.log).toEqual(["webview: test-platform ok"]);
    const missing = fakeDeps({
      checkWebview: async () => {
        throw new Error("libwebkit2gtk-4.1.so.0: cannot open shared object file");
      },
    });
    expect(await runDesktop(["--check"], missing.deps)).toBe(1);
    expect(missing.calls.error[0]).toContain("libwebkit2gtk");

    const help = fakeDeps();
    expect(await runDesktop(["--help"], help.deps)).toBe(0);
    expect(help.calls.log).toEqual([HELP]);
    expect(await runDesktop(["--port", "x"], help.deps)).toBe(2);
  });
});

// The real addon. Skips explain themselves; CI sets PERCH_DESKTOP_NATIVE=1 so they cannot skip there.
const nativeRequired = process.env.PERCH_DESKTOP_NATIVE === "1";
let nativeError = "";
try {
  await checkWebview();
} catch (error) {
  nativeError = error instanceof Error ? error.message : String(error);
}
const hasDisplay =
  process.platform === "win32" || process.platform === "darwin" || Boolean(process.env.DISPLAY);

describe.skipIf(!nativeRequired && nativeError !== "")("the native webview layer", () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-desktop-"));
  afterAll(() => {
    /**
     * Best effort, and it has to be. Windows keeps a handle on WebView2's browsing-data directory
     * for a while after the process that opened it is gone, so this used to fail the suite with
     * EBUSY after every assertion in it had passed. Whether a temp directory was deleted is not
     * something this suite is testing, and the runner's temp is wiped either way.
     */
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (error) {
      console.log(`left ${dir} behind: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  test("--check loads the platform webview", async () => {
    expect(nativeError).toBe("");
    const report = await checkWebview();
    console.log(`webview: ${report}`);
    expect(report).toContain(`${process.platform}-${process.arch} ok`);
    expect(browsingDataDir(dir)).toBe(join(dir, "desktop", "webview"));
  });

  // In a child process: a platform that stalls inside its webview blocks that process's event loop,
  // and a blocked loop cannot fire a test timeout. The parent kills it after two minutes and prints
  // the trace, so a stall fails fast and says where it stopped.
  async function smoke(serverMode: "inprocess" | "child", subdir: string): Promise<void> {
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "src", "index.ts"),
        "--smoke",
        "--data-dir",
        join(dir, subdir),
        "--log-level",
        "info",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PERCH_LOG_LEVEL: "info", PERCH_DESKTOP_SERVER: serverMode },
      },
    );
    const killer = setTimeout(() => proc.kill(), 120_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(killer);
    if (exitCode !== 0) console.error(`perch-desktop --smoke exited ${exitCode}\n${stderr}`);
    expect(exitCode).toBe(0);
    const lines = stdout
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as {
            smoke?: string;
            url?: string;
            loaded?: string | null;
            pageEvents?: boolean;
            path?: string;
            status?: number;
            msg?: string;
          };
        } catch {
          return null;
        }
      })
      .filter((line) => line !== null);
    const report = lines.find((line) => line.smoke !== undefined);
    expect(report?.smoke).toBe("ok");
    if (report?.pageEvents) {
      expect(report.loaded?.startsWith(report.url ?? "?")).toBe(true);
    } else {
      // Windows: the shell cannot see page loads; the server's request log shows the webview
      // fetched the app (info level, one line per request).
      const pageRequests = lines.filter(
        (line) => line.msg === "request" && line.path === "/" && line.status === 200,
      );
      expect(pageRequests.length).toBeGreaterThan(0);
    }
  }

  // Windows: the native loop owns the main thread, so an in-process server could never answer.
  test.skipIf((!nativeRequired && !hasDisplay) || process.platform === "win32")(
    "--smoke opens a window on laptop mode, loads the app, and closes",
    () => smoke("inprocess", "smoke"),
    150_000,
  );

  test.skipIf(!nativeRequired && !hasDisplay)(
    "--smoke with the server in a child process (the Windows layout) does the same",
    () => smoke("child", "smoke-child"),
    150_000,
  );
});

describe.skipIf(nativeRequired || nativeError === "")(
  "the native webview layer (unavailable here)",
  () => {
    test(`skipped: ${nativeError.split("\n")[0]}`, () => {
      expect(nativeError).not.toBe("");
    });
  },
);
