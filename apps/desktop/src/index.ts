#!/usr/bin/env bun
/**
 * The perch-desktop binary (ADR-0063): Perch on this machine in its own window. Arguments and the flow
 * live in desktop.ts (testable with fakes); the native window in window.ts; laptop mode itself comes
 * from @perch/cli.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDirFrom, startLaptop } from "@perch/cli/laptop";
import { parseDesktopArgs, probePerch, runDesktop } from "./desktop.ts";
import { childLaptopStarter } from "./laptop-child.ts";
import { chooseSink } from "./sink.ts";
import { checkWebview, openWindow } from "./window.ts";

export const packageName = "@perch/desktop";

export async function main(argv: string[]): Promise<number> {
  // Windows: the main thread owns the native run loop, so the server runs in a child process of this
  // binary (`--serve`, which always serves in-process: no recursion). PERCH_DESKTOP_SERVER=child|inprocess
  // overrides the choice on the other platforms (the tests exercise both layouts).
  const serverMode =
    process.env.PERCH_DESKTOP_SERVER ?? (process.platform === "win32" ? "child" : "inprocess");
  const inChild = serverMode === "child" && !argv.includes("--serve");
  const parsed = parseDesktopArgs(argv);
  const sink = await chooseSink(dataDirFrom("dataDir" in parsed ? parsed.dataDir : undefined));
  return runDesktop(argv, {
    startLaptop: inChild ? childLaptopStarter((stream, line) => sink[stream](line)) : startLaptop,
    openWindow,
    checkWebview,
    isPerchAt: probePerch,
    dataDirFrom,
    tempDir: () => mkdtempSync(join(tmpdir(), "perch-desktop-smoke-")),
    holdUntilReleased: () =>
      new Promise<void>((resolve) => {
        process.stdin.on("end", () => resolve());
        process.stdin.on("close", () => resolve());
        process.stdin.resume();
        process.once("SIGTERM", () => resolve());
        process.once("SIGINT", () => resolve());
      }),
    postWindowClose: async (hwnd, afterMs) => {
      await Bun.sleep(afterMs);
      if (process.platform !== "win32") return;
      const { dlopen, FFIType } = await import("bun:ffi");
      const user32 = dlopen("user32.dll", {
        PostMessageW: {
          args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64],
          returns: FFIType.i32,
        },
      });
      const WM_CLOSE = 0x0010;
      user32.symbols.PostMessageW(BigInt(hwnd), WM_CLOSE, 0n, 0n);
    },
    log: sink.out,
    error: sink.err,
  });
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
