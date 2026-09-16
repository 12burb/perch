import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Task 2.19's "bot-sdk published": the package an external bot installs is built here, so what it
 * contains is a test rather than a hope. The npm name is unscoped and the module has no
 * dependencies — a bot should be a file you can run.
 */

const root = resolve(import.meta.dir, "..");

describe("the perch-bot-sdk npm package", () => {
  test("stages a dependency-free module with its types", async () => {
    const out = mkdtempSync(join(tmpdir(), "perch-bot-sdk-"));
    try {
      const built = Bun.spawnSync(
        ["bun", "scripts/build-bot-sdk.ts", "--out", out, "--version", "9.9.9"],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(built.stderr.toString()).not.toContain("error:");
      expect(built.exitCode).toBe(0);

      const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as {
        name: string;
        version: string;
        dependencies?: Record<string, string>;
        exports: Record<string, { types: string; default: string }>;
      };
      expect(pkg.name).toBe("perch-bot-sdk");
      expect(pkg.version).toBe("9.9.9");
      expect(pkg.dependencies).toBeUndefined();
      expect(pkg.exports["."]).toEqual({ types: "./index.d.ts", default: "./index.js" });

      // The module is importable and carries the class a bot is written against.
      const module = (await import(join(out, "index.js"))) as Record<string, unknown>;
      expect(typeof module.PerchBot).toBe("function");
      expect(typeof module.PerchBotError).toBe("function");

      const types = readFileSync(join(out, "index.d.ts"), "utf8");
      expect(types).toContain("declare class PerchBot");
      expect(types).toContain("BotScope");
      // Nothing from the monorepo is imported: a package people install on its own stands alone.
      const bundled = readFileSync(join(out, "index.js"), "utf8");
      expect(bundled).not.toMatch(/(?:from|require\()\s*["']/);
      expect(bundled).toContain("/api/bot/");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
