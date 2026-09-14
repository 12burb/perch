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
      // Without a manifest every chunk is the app's.
      expect(report.appJsGzipKb).toBe(report.totalJsGzipKb);
      expect(report.packsJsGzipKb).toBe(0);
      expect(audit(dist).ok).toBe(true);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test("with a manifest, a library's lazy packs count apart from the app's own chunks", () => {
    const dist = mkdtempSync(join(tmpdir(), "perch-dist-"));
    try {
      mkdirSync(join(dist, "assets"));
      mkdirSync(join(dist, ".vite"));
      writeFileSync(
        join(dist, "index.html"),
        '<script type="module" src="/assets/index-abc.js"></script>',
      );
      const blob = (seed: number) =>
        Array.from({ length: 4096 }, (_, i) =>
          ((i * 7919 + seed) % 256).toString(16).padStart(2, "0"),
        ).join("");
      for (const name of ["index-abc", "route-r1", "shared-s1", "lang-l1", "lang-l2"]) {
        writeFileSync(join(dist, "assets", `${name}.js`), `/*${blob(name.length)}*/`);
      }
      writeFileSync(
        join(dist, ".vite", "manifest.json"),
        JSON.stringify({
          "index.html": {
            file: "assets/index-abc.js",
            isEntry: true,
            imports: ["_shared-s1.js"],
            dynamicImports: ["src/routes/r1.tsx"],
          },
          "_shared-s1.js": {
            file: "assets/shared-s1.js",
            dynamicImports: ["../../node_modules/lang-l1/index.js"],
          },
          "src/routes/r1.tsx": {
            file: "assets/route-r1.js",
            isDynamicEntry: true,
            dynamicImports: ["../../node_modules/lang-l2/index.js"],
          },
          "../../node_modules/lang-l1/index.js": {
            file: "assets/lang-l1.js",
            isDynamicEntry: true,
          },
          "../../node_modules/lang-l2/index.js": {
            file: "assets/lang-l2.js",
            isDynamicEntry: true,
          },
        }),
      );
      const report = measureBundle(dist);
      const kb = (name: string) =>
        report.files.find((f) => f.file === `assets/${name}.js`)?.gzipKb ?? 0;
      expect(report.appJsGzipKb).toBe(
        Math.round((kb("index-abc") + kb("shared-s1") + kb("route-r1")) * 10) / 10,
      );
      expect(report.packsJsGzipKb).toBe(Math.round((kb("lang-l1") + kb("lang-l2")) * 10) / 10);
      expect(report.totalJsGzipKb).toBe(
        Math.round((report.appJsGzipKb + report.packsJsGzipKb) * 10) / 10,
      );
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
