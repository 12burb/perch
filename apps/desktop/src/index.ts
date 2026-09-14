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
import { startLaptopInWorker } from "./laptop-worker.ts";
import { checkWebview, openWindow } from "./window.ts";

export const packageName = "@perch/desktop";

export function main(argv: string[]): Promise<number> {
  return runDesktop(argv, {
    // Windows: the main thread owns the native run loop, so the server runs on a worker thread.
    startLaptop: process.platform === "win32" ? startLaptopInWorker : startLaptop,
    openWindow,
    checkWebview,
    isPerchAt: probePerch,
    dataDirFrom,
    tempDir: () => mkdtempSync(join(tmpdir(), "perch-desktop-smoke-")),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
