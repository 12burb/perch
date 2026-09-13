import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBackup, restoreBackup } from "../src/commands/backup.ts";
import { collectChecks, formatChecks } from "../src/commands/doctor.ts";
import { laptopLayout } from "../src/paths.ts";

/**
 * The laptop smoke test (task 0.14): `perch dev` starts on PGlite with the in-process runner, answers
 * health with mode laptop and one runner, serves the setup wizard, and stops on SIGTERM; then doctor,
 * backup, and restore work against the data it created. CI runs this on Linux, macOS, and Windows.
 */

const cli = resolve(import.meta.dir, "..", "src", "index.ts");
let dataDir = "";

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "perch-laptop-"));
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<{ match: RegExpMatchArray; output: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(() => null),
    ]);
    if (chunk === null) break;
    if (chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
    const match = output.match(pattern);
    if (match) {
      reader.releaseLock();
      return { match, output };
    }
  }
  reader.releaseLock();
  throw new Error(`pattern ${pattern} not seen in:\n${output}`);
}

describe("laptop mode (task 0.14)", () => {
  test("perch dev boots on PGlite with the in-process runner and stops cleanly", async () => {
    const proc = Bun.spawn(
      ["bun", cli, "dev", "--port", "0", "--data-dir", dataDir, "--log-level", "warn"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PERCH_PUBLIC_URL: "", PORT: "" },
      },
    );
    try {
      const { match } = await readUntil(proc.stdout, /perch dev: (http:\/\/[^\s]+)/, 60_000);
      const url = match[1] ?? "";
      const health = (await (await fetch(`${url}/api/health`)).json()) as {
        status: string;
        mode: string;
        checks: { database: string; runners: number };
      };
      expect(health).toMatchObject({
        status: "ok",
        mode: "laptop",
        checks: { database: "ok", runners: 1 },
      });
      const instance = (await (await fetch(`${url}/api/instance`)).json()) as {
        mode: string;
        setup_complete: boolean;
      };
      expect(instance).toMatchObject({ mode: "laptop", setup_complete: false });
      // The web app (when built) and the wizard are served from the same port.
      const page = await fetch(`${url}/setup`);
      expect([200, 404]).toContain(page.status);
      expect(existsSync(join(dataDir, "master.key"))).toBe(true);
      expect(existsSync(join(dataDir, "data"))).toBe(true);
    } finally {
      proc.kill("SIGTERM");
    }
    expect(await proc.exited).toBe(0);
  }, 90_000);

  test("perch doctor reports the data dir, database, and tools", async () => {
    const checks = await collectChecks({ dataDir, port: 0, host: "127.0.0.1" });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName.bun?.ok).toBe(true);
    expect(byName["data dir writable"]?.ok).toBe(true);
    expect(byName["database (PGlite)"]?.ok).toBe(true);
    expect(byName["database (PGlite)"]?.detail).toContain("0 applied now");
    expect(byName["master key"]?.detail).toContain("master.key");
    expect(formatChecks(checks)).toContain("ok    bun");
    expect(checks.filter((c) => c.required && !c.ok)).toEqual([]);
  }, 60_000);

  test("backup and restore round-trip the PGlite data, files, and master key", async () => {
    const layout = laptopLayout(dataDir);
    mkdirSync(layout.files, { recursive: true });
    writeFileSync(join(layout.files, "hello.txt"), "hi");
    const out = join(dataDir, "backup");
    const manifest = await createBackup(dataDir, out);
    expect(manifest).toMatchObject({
      format: "perch-backup",
      version: 1,
      files: true,
      masterKey: true,
    });
    expect(readdirSync(out).sort()).toEqual([
      "files",
      "manifest.json",
      "master.key",
      "pglite.tar.gz",
    ]);
    await expect(createBackup(dataDir, out)).rejects.toThrow(/not empty/);

    const restored = mkdtempSync(join(tmpdir(), "perch-restore-"));
    try {
      await restoreBackup(out, restored);
      const restoredLayout = laptopLayout(restored);
      expect(existsSync(join(restoredLayout.files, "hello.txt"))).toBe(true);
      expect(existsSync(restoredLayout.masterKey)).toBe(true);
      const checks = await collectChecks({ dataDir: restored, port: 0, host: "127.0.0.1" });
      expect(checks.find((c) => c.name === "database (PGlite)")?.detail).toContain("0 applied now");
      await expect(restoreBackup(out, restored)).rejects.toThrow(/--force/);
      await restoreBackup(out, restored, { force: true });
    } finally {
      rmSync(restored, { recursive: true, force: true });
    }
  }, 120_000);
});
