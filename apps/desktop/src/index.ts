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
import { probePerch, runDesktop } from "./desktop.ts";
import { startLaptopInChild } from "./laptop-child.ts";
import { checkWebview, openWindow } from "./window.ts";

export const packageName = "@perch/desktop";

export function main(argv: string[]): Promise<number> {
  // Windows: the main thread owns the native run loop, so the server runs in a child process of this
  // binary (`--serve`, which always serves in-process: no recursion). PERCH_DESKTOP_SERVER=child|inprocess
  // overrides the choice on the other platforms (the tests exercise both layouts).
  const serverMode =
    process.env.PERCH_DESKTOP_SERVER ?? (process.platform === "win32" ? "child" : "inprocess");
  const inChild = serverMode === "child" && !argv.includes("--serve");
  return runDesktop(argv, {
    startLaptop: inChild ? startLaptopInChild : startLaptop,
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
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
