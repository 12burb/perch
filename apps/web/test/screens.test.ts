import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Every route is a screen the accessibility sweep visits, or a route with a written reason why it
 * is not one (task 4.11).
 *
 * `e2e/a11y.e2e.ts` audits a list. A list is only worth having if it cannot fall behind the app, so
 * this reads `apps/web/src/routes/**` and asserts that every route file appears either in `SCREENS`
 * or in `NOT_SCREENS` — which is the same shape as the route-authorization table (`docs/audit.md`)
 * and the docs sidebar: a net, with an exemption list that has to say why.
 *
 * It reads the spec as text rather than importing it: the spec imports Playwright, which is not
 * something `bun test` should have to load.
 */

const web = resolve(import.meta.dir, "..");
const routesDir = join(web, "src", "routes");
const spec = readFileSync(resolve(web, "..", "..", "e2e", "a11y.e2e.ts"), "utf8");

/** Every route file, as a path relative to `src/routes`. */
function routeFiles(dir = routesDir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(path));
    else if (entry.name.endsWith(".tsx")) out.push(relative(routesDir, path).replaceAll("\\", "/"));
  }
  return out.sort();
}

/** The `route:` values in SCREENS, and the keys of NOT_SCREENS. */
function named(): { audited: string[]; excused: string[] } {
  const audited = [...spec.matchAll(/route:\s*"([^"]+)"/g)].map((one) => one[1] ?? "");
  const block = /export const NOT_SCREENS[^{]*\{([\s\S]*?)\n\};/.exec(spec)?.[1] ?? "";
  const excused = [...block.matchAll(/"([^"]+)":\s*"/g)].map((one) => one[1] ?? "");
  return { audited, excused };
}

describe("every screen is audited (task 4.11)", () => {
  const files = routeFiles();
  const { audited, excused } = named();

  test("there are routes to check, and the spec names some of them", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(audited.length).toBeGreaterThan(5);
    expect(excused.length).toBeGreaterThan(0);
  });

  test("every route is audited or excused", () => {
    const covered = new Set([...audited, ...excused]);
    expect(files.filter((file) => !covered.has(file))).toEqual([]);
  });

  test("nothing is both audited and excused", () => {
    expect(audited.filter((route) => excused.includes(route))).toEqual([]);
  });

  test("an excuse that no longer matches a route is removed", () => {
    const real = new Set(files);
    expect([...audited, ...excused].filter((route) => !real.has(route))).toEqual([]);
  });

  test("every excuse says why, in a sentence", () => {
    const block = /export const NOT_SCREENS[^{]*\{([\s\S]*?)\n\};/.exec(spec)?.[1] ?? "";
    for (const [, route, reason] of block.matchAll(/"([^"]+)":\s*\n?\s*"([^"]+)"/g)) {
      expect((reason ?? "").length, route).toBeGreaterThan(20);
    }
  });
});
