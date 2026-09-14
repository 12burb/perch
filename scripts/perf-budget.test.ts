import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, BUDGETS, measureBundle, sampleEnvelopes } from "./perf-budget.ts";

describe("perf budgets (task 0.15)", () => {
  test("measures the initial chunk from index.html and every chunk in assets", () => {
    const dist = mkdtempSync(join(tmpdir(), "perch-dist-"));
    try {
      mkdirSync(join(dist, "assets"));
      writeFileSync(
        join(dist, "index.html"),
        '<script type="module" src="/assets/index-abc.js"></script><link rel="stylesheet" href="/assets/index-abc.css">',
      );
      // Incompressible content so every file measures well above the 0.1 KB rounding step.
      const blob = (seed: number) =>
        Array.from({ length: 4096 }, (_, i) =>
          ((i * 7919 + seed) % 256).toString(16).padStart(2, "0"),
        ).join("");
      writeFileSync(join(dist, "assets", "index-abc.js"), `/*${blob(1)}*/`);
      writeFileSync(join(dist, "assets", "lazy-def.js"), `/*${blob(2)}*/`);
      writeFileSync(join(dist, "assets", "index-abc.css"), `/*${blob(3)}*/`);
      const report = measureBundle(dist);
      expect(report.files.map((f) => f.file).sort()).toEqual([
        "assets/index-abc.css",
        "assets/index-abc.js",
        "assets/lazy-def.js",
      ]);
      expect(report.initialGzipKb).toBeGreaterThan(0);
      expect(report.totalJsGzipKb).toBeGreaterThan(report.initialGzipKb - report.cssGzipKb);
      expect(audit(dist).ok).toBe(true);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test("a missing build fails the audit", () => {
    expect(audit("/nonexistent").ok).toBe(false);
  });

  test("the sample WS envelopes fit the budget", () => {
    for (const sample of sampleEnvelopes())
      expect(sample.bytes).toBeLessThanOrEqual(BUDGETS.wsEnvelopeBytes);
  });
});
