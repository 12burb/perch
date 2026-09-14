#!/usr/bin/env bun
/**
 * The perch-desktop binary (ADR-0063): Perch on this machine in its own window. Arguments and the flow
 * live in desktop.ts (testable with fakes); the native window in window.ts; laptop mode itself comes
 * from @perch/cli.
 */
import { dataDirFrom, startLaptop } from "@perch/cli/laptop";
import { probePerch, runDesktop } from "./desktop.ts";
import { checkWebview, openWindow } from "./window.ts";

export const packageName = "@perch/desktop";

export function main(argv: string[]): Promise<number> {
  return runDesktop(argv, {
    startLaptop,
    openWindow,
    checkWebview,
    isPerchAt: probePerch,
    dataDirFrom,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
