import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  audit,
  BUDGETS,
  LIST_SURFACES,
  listVirtualization,
  measureBundle,
  sampleEnvelopes,
} from "./perf-budget.ts";

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

/**
 * Ground rule 7 as a gate (task 2.20): every long list is virtualized, or capped where the check
 * can read the cap. These tests are about the gate itself — that it passes on this repository, and
 * that it notices the two ways the rule gets broken.
 */
describe("the long-list check (task 2.20)", () => {
  const root = resolve(import.meta.dir, "..");

  test("every list surface in this repository is accounted for", () => {
    expect(listVirtualization(root)).toEqual([]);
    expect(LIST_SURFACES.length).toBeGreaterThan(10);
  });

  test("a surface that stops virtualizing is reported", () => {
    const fake = mkdtempSync(join(tmpdir(), "perch-lists-"));
    try {
      for (const surface of LIST_SURFACES) {
        const file = surface.file.split("#")[0] ?? surface.file;
        mkdirSync(join(fake, dirname(file)), { recursive: true });
        // Every file exists and says nothing: virtualized surfaces lose their window, and the
        // files a cap was proved in lose the cap.
        writeFileSync(join(fake, file), "export const nothing = 1;\n");
      }
      const findings = listVirtualization(fake);
      const virtualized = LIST_SURFACES.filter((one) => one.how === "virtualized");
      for (const surface of virtualized) {
        expect(findings.some((f) => f.file === surface.file)).toBe(true);
      }
      expect(findings.some((f) => f.problem.includes("renders every row"))).toBe(true);
      expect(findings.some((f) => f.problem.includes("the cap of"))).toBe(true);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  test("the Database panel's tables and result rows are registered, with the paging as proof (A-wc-19)", () => {
    const ship = LIST_SURFACES.filter(
      (one) => (one.file.split("#")[0] ?? one.file) === "apps/web/src/code/ship-panel.tsx",
    );
    expect(ship).toHaveLength(2);
    for (const one of ship) {
      expect(one.how).toMatchObject({ capped: 100, in: "apps/web/src/code/ship-panel.tsx" });
    }
    // And the proofs are in the panel as it is: nothing about it is reported.
    expect(listVirtualization(root).filter((f) => f.file.includes("ship-panel"))).toEqual([]);
  });

  test("a new scrolling list that nobody registered is reported", () => {
    const added = join(root, "apps/web/src/perf-budget-fixture.tsx");
    try {
      writeFileSync(
        added,
        [
          "export function Fixture(props: { rows: string[] }) {",
          '  return <div className="overflow-y-auto">{props.rows.map((row) => row)}</div>;',
          "}",
          "",
        ].join("\n"),
      );
      const findings = listVirtualization(root);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.file).toBe("apps/web/src/perf-budget-fixture.tsx");
      expect(findings[0]?.problem).toContain("not a registered surface");
    } finally {
      rmSync(added, { force: true });
    }
  });
});
