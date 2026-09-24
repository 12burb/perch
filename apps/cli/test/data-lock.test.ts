import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataDirInUse, lockDataDir, lockFile } from "../src/data-lock.ts";

/**
 * One Perch per data directory (ADR-0175). PGlite lets a second process open the same files, and
 * whichever closes last overwrites what the other committed; the lock is what stops the second.
 */

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "perch-lock-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** A pid that was running a moment ago and is not now. */
async function goneProcessId(): Promise<number> {
  const proc = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.pid;
}

describe("the data directory lock", () => {
  test("a second holder is refused with who holds it, and a release lets the next one in", () => {
    const first = lockDataDir(dataDir, "perch dev");
    expect(existsSync(lockFile(dataDir))).toBe(true);
    first.describe({ url: "http://127.0.0.1:3000" });
    let refused: unknown = null;
    try {
      lockDataDir(dataDir, "perch backup");
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(DataDirInUse);
    const holder = (refused as DataDirInUse).holder;
    expect(holder.pid).toBe(process.pid);
    expect(holder.command).toBe("perch dev");
    expect(holder.url).toBe("http://127.0.0.1:3000");
    expect((refused as Error).message).toContain(`pid ${process.pid}`);
    first.release();
    expect(existsSync(lockFile(dataDir))).toBe(false);
    const second = lockDataDir(dataDir, "perch backup");
    second.release();
    // Releasing twice is harmless.
    second.release();
  });

  test("a lock left by a process that is gone is taken over", async () => {
    const pid = await goneProcessId();
    writeFileSync(
      lockFile(dataDir),
      JSON.stringify({ pid, startedAt: new Date().toISOString(), command: "perch dev" }),
    );
    const lock = lockDataDir(dataDir, "perch doctor");
    const written = JSON.parse(readFileSync(lockFile(dataDir), "utf8")) as { pid: number };
    expect(written.pid).toBe(process.pid);
    lock.release();
  });

  test("a lock with this pid that this process never took is a leftover, not a holder", () => {
    // In a container every start can be pid 1: the lock a crashed start left has the same pid.
    writeFileSync(
      lockFile(dataDir),
      JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", command: "x" }),
    );
    const lock = lockDataDir(dataDir, "perch dev");
    lock.release();
  });

  test("an unreadable lock file is treated as a leftover", () => {
    writeFileSync(lockFile(dataDir), "not json");
    const lock = lockDataDir(dataDir, "perch dev");
    lock.release();
  });
});
