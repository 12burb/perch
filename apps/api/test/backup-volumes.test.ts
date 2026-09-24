import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../src/logging.ts";
import { backupVolumes } from "../src/supervisor/volumes.ts";

/**
 * The project volumes in a backup (task 4.4), now that members own their own files (ADR-0171): a
 * file one of them made private is left out and said so, and everything else is still backed up.
 * The supervisor is not root, so the backup runs as an ordinary uid here too: as the test process
 * where that is not root, and through setpriv as uid 1000 where it is.
 */

const root = process.platform === "linux" && process.getuid?.() === 0;
const supported = process.platform !== "win32";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "perch-backup-volumes-"));
  chmodSync(dir, 0o777);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!supported)("the project volumes in a backup", () => {
  test("a file the supervisor cannot read is left out; the rest is backed up", async () => {
    const source = join(dir, "projects");
    const project = join(source, "0190f2d0-0000-7000-8000-000000000001", "p");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "shared.txt"), "everyone's\n");
    writeFileSync(join(project, "private.key"), "only mine\n");
    chmodSync(join(project, "private.key"), 0o000);
    for (const path of [source, join(source, "0190f2d0-0000-7000-8000-000000000001"), project]) {
      chmodSync(path, 0o755);
    }
    chmodSync(join(project, "shared.txt"), 0o644);
    const out = join(dir, "backup");
    mkdirSync(out);
    chmodSync(out, 0o777);
    let result: { projects: number; bytes: number };
    if (root) {
      // Root reads everything; the supervisor is uid 1000, so the backup runs as that.
      const script = join(dir, "backup.ts");
      writeFileSync(
        script,
        [
          `import { backupVolumes } from ${JSON.stringify(join(import.meta.dir, "..", "src", "supervisor", "volumes.ts"))};`,
          `import { silentLogger } from ${JSON.stringify(join(import.meta.dir, "..", "src", "logging.ts"))};`,
          "const log = silentLogger();",
          `console.log(JSON.stringify(await backupVolumes(${JSON.stringify(out)}, log, { projects: ${JSON.stringify(source)} })));`,
        ].join("\n"),
      );
      const proc = Bun.spawnSync(
        [
          "setpriv",
          "--reuid=1000",
          "--regid=1000",
          "--clear-groups",
          "--",
          process.execPath,
          script,
        ],
        {
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      result = JSON.parse(proc.stdout.toString().trim().split("\n").at(-1) ?? "{}");
    } else {
      const log = silentLogger();
      const warn = spyOn(log, "warn");
      result = await backupVolumes(out, log, { projects: source });
      expect(warn).toHaveBeenCalledTimes(1);
    }
    expect(result.projects).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
    const listed = Bun.spawnSync(["tar", "-tzf", join(out, "projects.tar.gz")]).stdout.toString();
    expect(listed).toContain("shared.txt");
    expect(listed).not.toContain("private.key");
  }, 60_000);
});
