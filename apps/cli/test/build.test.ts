import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The compiled perch binary (task 0.15): scripts/build-cli.ts compiles for this platform with the web app
 * embedded and stages the npm package; the binary then runs `perch dev` and serves the embedded app.
 * Skipped without a web build (CI builds it first).
 */

const root = resolve(import.meta.dir, "..", "..", "..");
const hasWebBuild = existsSync(join(root, "apps", "web", "dist", "index.html"));
const target = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;

describe.skipIf(!hasWebBuild)("perch binary (task 0.15)", () => {
  test("compiles with the embedded web app and serves it from a data dir without a dist", async () => {
    const out = mkdtempSync(join(tmpdir(), "perch-build-"));
    const dataDir = mkdtempSync(join(tmpdir(), "perch-bin-data-"));
    try {
      const build = Bun.spawnSync(
        [
          "bun",
          "scripts/build-cli.ts",
          "--targets",
          target,
          "--out",
          out,
          "--version",
          "0.0.0-test",
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(build.exitCode, build.stderr.toString()).toBe(0);
      const binary = join(
        out,
        `perch-${target.replace(/^bun-/, "")}${process.platform === "win32" ? ".exe" : ""}`,
      );
      expect(existsSync(binary)).toBe(true);
      // The placeholder is restored after the build.
      expect(readFileSync(join(root, "apps", "cli", "src", "web-assets.gen.ts"), "utf8")).toContain(
        "= {};",
      );
      const npmPkg = JSON.parse(readFileSync(join(out, "npm", "package.json"), "utf8")) as {
        name: string;
        bin: { perch: string };
      };
      expect(npmPkg).toMatchObject({ name: "perch-dev", bin: { perch: "./perch.js" } });
      expect(existsSync(join(out, "npm", "web", "index.html"))).toBe(true);

      const help = Bun.spawnSync([binary, "--help"], { stdout: "pipe", stderr: "pipe" });
      expect(help.stdout.toString()).toContain("perch <command>");

      const proc = Bun.spawn(
        [binary, "dev", "--port", "0", "--data-dir", dataDir, "--log-level", "warn"],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, PERCH_WEB_DIST: "/nonexistent", PERCH_PUBLIC_URL: "", PORT: "" },
        },
      );
      try {
        const reader = proc.stdout.getReader();
        let output = "";
        let url = "";
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && !url) {
          const chunk = await reader.read();
          if (chunk.done) break;
          output += new TextDecoder().decode(chunk.value);
          url = output.match(/perch dev: (http:\/\/[^\s]+)/)?.[1] ?? "";
        }
        reader.releaseLock();
        expect(url, output).not.toBe("");
        const index = await fetch(`${url}/setup`);
        expect(index.status).toBe(200);
        expect(await index.text()).toContain('<div id="root">');
        const health = (await (await fetch(`${url}/api/health`)).json()) as {
          checks: { runners: number };
        };
        expect(health.checks.runners).toBe(1);
      } finally {
        proc.kill("SIGTERM");
        await proc.exited;
      }
    } finally {
      rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 180_000);
});
