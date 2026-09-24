import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger } from "@perch/api/logging";
import { BackupsService, fingerprintKey } from "@perch/api/services/backups";
import { createDb, schema } from "@perch/db";
import { generateMasterKey } from "@perch/vault";
import { within } from "../../../scripts/launch-bar.ts";
import { createBackup, restoreBackup } from "../src/commands/backup.ts";
import { collectChecks, formatChecks } from "../src/commands/doctor.ts";
import { DataDirInUse, lockDataDir, lockFile } from "../src/data-lock.ts";
import { startLaptop } from "../src/laptop.ts";
import { laptopLayout } from "../src/paths.ts";
import { webAssets } from "../src/web-assets.gen.ts";

/**
 * The laptop smoke test (task 0.14): `perch dev` starts on PGlite with the in-process runner, answers
 * health with mode laptop and one runner, serves the setup wizard, and stops on SIGTERM (or a kill on
 * Windows); then doctor,
 * backup, and restore work against the data it created. CI runs this on Linux, macOS, and Windows.
 */

const cli = resolve(import.meta.dir, "..", "src", "index.ts");
let dataDir = "";

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "perch-laptop-"));
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
    // The other way in, and a leg of the launch bar (task 4.13): from the command to an instance
    // that answers, with its runner already in it.
    const started = performance.now();
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
      within("laptop-boot", performance.now() - started);

      // One Perch per data directory (ADR-0175): while it runs, nothing else opens its database —
      // a second opener would overwrite what this one committed when it closed.
      const lock = JSON.parse(readFileSync(lockFile(dataDir), "utf8")) as {
        pid: number;
        url: string;
      };
      expect(lock.pid).toBe(proc.pid);
      expect(lock.url).toBe(url);
      await expect(startLaptop({ dataDir, port: 0, logLevel: "silent" })).rejects.toThrow(
        `pid ${proc.pid}`,
      );
      await expect(createBackup(dataDir, join(dataDir, "not-now"))).rejects.toBeInstanceOf(
        DataDirInUse,
      );
      expect(existsSync(join(dataDir, "not-now"))).toBe(false);
      const checks = await collectChecks({ dataDir, port: 0, host: "127.0.0.1" });
      expect(checks.find((c) => c.name === "database (PGlite)")?.detail).toContain(
        `in use by perch dev (pid ${proc.pid}`,
      );
    } finally {
      proc.kill("SIGTERM");
    }
    // A clean exit code needs signal delivery; Windows terminates the process instead.
    const exit = await proc.exited;
    if (process.platform !== "win32") {
      expect(exit).toBe(0);
      // A clean stop lets go of the directory.
      expect(existsSync(lockFile(dataDir))).toBe(false);
    }
  }, 90_000);

  test("stopping laptop mode closes the instance and lets go of the data directory", async () => {
    // RunningServer.stop() is Booted.close() (ADR-0109); stop() adds the lock's release.
    const own = mkdtempSync(join(tmpdir(), "perch-stop-"));
    try {
      const laptop = await startLaptop({ dataDir: own, port: 0, logLevel: "silent" });
      expect(existsSync(lockFile(own))).toBe(true);
      await laptop.stop();
      expect(existsSync(lockFile(own))).toBe(false);
      const refused = await (async () =>
        laptop.booted.db.db.select().from(schema.workspaces))().then(
        () => null,
        (error: unknown) => error,
      );
      const cause = refused instanceof Error ? refused.cause : null;
      expect(cause instanceof Error ? cause.message : String(cause)).toContain(
        "the database is closing",
      );
      // And the next one may have it.
      const again = lockDataDir(own, "test");
      again.release();
    } finally {
      rmSync(own, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
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

  test("doctor does not claim the web app is missing from a binary that carries it", async () => {
    // A compiled `perch` embeds the web app, so there is no directory to stat; before v0.3.0 the
    // check looked for one anyway and told everybody who downloaded a release that their web build
    // was missing, on a binary that was serving it perfectly well.
    const checks = await collectChecks({ dataDir, port: 0, host: "127.0.0.1" });
    const web = checks.find((one) => one.name === "web build");
    expect(web).toBeDefined();
    const embedded = Object.keys(webAssets).length;
    if (embedded > 0) {
      expect(web?.ok).toBe(true);
      expect(web?.detail).toContain(`embedded in this binary (${embedded} files)`);
    } else {
      // Running from the source tree: what it says depends on whether the app has been built, and
      // either way it is never "embedded".
      expect(web?.detail).not.toContain("embedded");
    }
  }, 60_000);

  test("backup and restore round-trip the PGlite data, files, and master key", async () => {
    const layout = laptopLayout(dataDir);
    mkdirSync(layout.files, { recursive: true });
    writeFileSync(join(layout.files, "hello.txt"), "hi");
    const key = readFileSync(layout.masterKey, "utf8").trim();

    // By default the vault key stays home: the backup records its fingerprint (docs/backups.md).
    const sealed = join(dataDir, "backup-sealed");
    const plain = await createBackup(dataDir, sealed, { includeKey: false });
    expect(plain.masterKey).toEqual({ included: false, fingerprint: fingerprintKey(key) });
    expect(existsSync(join(sealed, "master.key"))).toBe(false);
    if (process.platform !== "win32") expect(statSync(sealed).mode & 0o777).toBe(0o700);

    const out = join(dataDir, "backup");
    const manifest = await createBackup(dataDir, out, { includeKey: true });
    // The one format a team instance writes too (ADR-0175), with the exact copy beside the dump.
    expect(manifest).toMatchObject({
      format: "perch-instance-backup",
      version: 1,
      mode: "laptop",
      driver: "pglite",
      files: { dir: "files", count: 1 },
      masterKey: { included: true, fingerprint: fingerprintKey(key) },
      pglite: "pglite.tar.gz",
    });
    // A backup carries both copies: the exact one, and the one that restores anywhere (task 4.4).
    expect(readdirSync(out).sort()).toEqual([
      "database.jsonl.gz",
      "files",
      "manifest.json",
      "master.key",
      "pglite.tar.gz",
    ]);
    expect(manifest.database.tables).toBeGreaterThan(50);
    await expect(createBackup(dataDir, out)).rejects.toThrow(/not empty/);

    const restored = mkdtempSync(join(tmpdir(), "perch-restore-"));
    try {
      const outcome = await restoreBackup(out, restored);
      expect(outcome).toMatchObject({ from: "exact", keyRestored: true, keyMatches: true });
      const restoredLayout = laptopLayout(restored);
      expect(existsSync(join(restoredLayout.files, "hello.txt"))).toBe(true);
      expect(readFileSync(restoredLayout.masterKey, "utf8").trim()).toBe(key);
      // A directory another Perch holds is not restored into.
      const held = lockDataDir(restored, "a test holding it");
      await expect(restoreBackup(out, restored, { force: true })).rejects.toBeInstanceOf(
        DataDirInUse,
      );
      held.release();
      const checks = await collectChecks({ dataDir: restored, port: 0, host: "127.0.0.1" });
      expect(checks.find((c) => c.name === "database (PGlite)")?.detail).toContain("0 applied now");
      await expect(restoreBackup(out, restored)).rejects.toThrow(/--force/);
      await restoreBackup(out, restored, { force: true });
      // And the portable dump restores into an empty data directory on its own: migrations first,
      // then the rows, which is exactly what a team instance does with the same file.
      await restoreBackup(out, restored, { force: true, portable: true });
      const portableChecks = await collectChecks({ dataDir: restored, port: 0, host: "127.0.0.1" });
      expect(portableChecks.find((c) => c.name === "database (PGlite)")?.detail).toContain(
        "0 applied now",
      );
    } finally {
      rmSync(restored, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);

  test("a laptop backup restores into a team instance, and a team backup into laptop mode", async () => {
    // The README's promise: `perch backup` carries a laptop into the compose stack and back.
    const silent = createLogger({ level: "silent" });
    const teamFiles = mkdtempSync(join(tmpdir(), "perch-team-files-"));
    const teamBackups = mkdtempSync(join(tmpdir(), "perch-team-backups-"));
    const back = mkdtempSync(join(tmpdir(), "perch-back-"));
    const laptopBackup = join(dataDir, "backup-for-team");
    const teamKey = generateMasterKey();
    const team = await createDb({ url: "pglite://memory" });
    try {
      // Something in the laptop's database worth carrying.
      const writer = lockDataDir(dataDir, "the test");
      const laptopDb = await createDb({ url: laptopLayout(dataDir).databaseUrl });
      try {
        await laptopDb.db.insert(schema.workspaces).values({ name: "Carried", slug: "carried" });
      } finally {
        await laptopDb.close();
        writer.release();
      }
      const written = await createBackup(dataDir, laptopBackup);
      const service = new BackupsService({
        env: {
          mode: "team",
          filesDir: teamFiles,
          masterKey: teamKey,
          backup: { dir: teamBackups, cron: "0 3 * * *", keep: 7, includeKey: false },
        },
        db: team,
        log: silent,
        version: { version: "test" },
      });
      const restored = await service.restore(laptopBackup);
      // Every row the laptop's dump carried went in.
      expect(restored.rows).toBe(written.database.rows);
      const carried = await team.db.select().from(schema.workspaces);
      expect(carried.filter((one) => one.slug === "carried").map((one) => one.name)).toEqual([
        "Carried",
      ]);
      // A different key on the team side, and the manifest says so.
      expect(restored.keyMatches).toBe(false);
      expect(readFileSync(join(teamFiles, "hello.txt"), "utf8")).toBe("hi");

      // And back: the team's own backup, into an empty laptop data directory, from its dump.
      const taken = await service.create();
      const outcome = await restoreBackup(taken.path, back);
      expect(outcome.from).toBe("portable");
      expect(outcome.keyRestored).toBe(false);
      expect(existsSync(join(laptopLayout(back).files, "hello.txt"))).toBe(true);
      const checks = await collectChecks({ dataDir: back, port: 0, host: "127.0.0.1" });
      expect(checks.find((c) => c.name === "database (PGlite)")?.detail).toContain("0 applied now");
      const home = await createDb({ url: laptopLayout(back).databaseUrl });
      try {
        const there = await home.db.select().from(schema.workspaces);
        expect(there.filter((one) => one.slug === "carried")).toHaveLength(1);
      } finally {
        await home.close();
      }
    } finally {
      await team.close();
      for (const dir of [teamFiles, teamBackups, back, laptopBackup]) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  }, 180_000);
});
