import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLinks,
  type Page,
  pages,
  REPO_BLOB,
  rewrite,
  routeOf,
  sidebar,
  slugOf,
} from "./docs-site.ts";

/**
 * The docs site (task 4.7): every page under `docs/` is on it, every link between them lands, and
 * a broken one fails the build rather than shipping.
 */

function corpus(files: Record<string, string>): Page[] {
  const dir = mkdtempSync(join(tmpdir(), "perch-docs-"));
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  return pages(dir);
}

describe("routes and titles (task 4.7)", () => {
  test("a file becomes the route somebody would guess", () => {
    expect(routeOf("README.md")).toBe("/");
    expect(routeOf("deploy.md")).toBe("/deploy/");
    expect(routeOf("policies/providers.md")).toBe("/policies/providers/");
    expect(routeOf("spec/PERCH-SPEC.md")).toBe("/spec/perch-spec/");
    expect(routeOf("rfcs/README.md")).toBe("/rfcs/");
  });

  test("headings become the anchors a link can name", () => {
    expect(slugOf("Who may do what")).toBe("who-may-do-what");
    expect(slugOf("`perch runner connect`")).toBe("perch-runner-connect");
    expect(slugOf("1. Write the deployment")).toBe("1-write-the-deployment");
  });

  test("the title is the page's own heading and the description its first paragraph", () => {
    const [page] = corpus({
      "deploy.md": "# Deploying Perch\n\nFour containers by default.\n\n## More\n",
    });
    expect(page?.title).toBe("Deploying Perch");
    expect(page?.description).toBe("Four containers by default.");
    expect(page?.anchors.has("more")).toBe(true);
  });
});

describe("links (task 4.7)", () => {
  const files = {
    "README.md": "# Docs\n\n[deploy](deploy.md), [rules](../AGENTS.md), [rfc](rfcs/0001.md)\n",
    "deploy.md":
      "# Deploy\n\nBack to the [index](./README.md#docs) and on to [runners](./runners.md).\n",
    "runners.md": "# Runners\n\nNothing links out of here.\n",
    "rfcs/0001.md": "# One\n\nUp to [deploy](../deploy.md).\n",
  };

  test("a link between pages becomes a route, and one that leaves docs/ goes to GitHub", () => {
    const all = corpus(files);
    const deploy = all.find((page) => page.file === "deploy.md");
    expect(deploy).toBeDefined();
    if (!deploy) return;
    const written = rewrite(deploy, all);
    expect(written).toContain("[index](/#docs)");
    expect(written).toContain("[runners](/runners/)");

    const index = all.find((page) => page.file === "README.md");
    expect(index && rewrite(index, all)).toContain(`[rules](${REPO_BLOB}/AGENTS.md)`);
    expect(index && rewrite(index, all)).toContain("[rfc](/rfcs/0001/)");
  });

  test("a page that is not there, and an anchor that is not there, are both found", () => {
    const all = corpus({
      ...files,
      "deploy.md": "# Deploy\n\n[gone](./nowhere.md) and [wrong](./runners.md#nope)\n",
    });
    const problems = checkLinks(all);
    expect(problems.map((one) => one.why).sort()).toEqual([
      "no page with that path",
      "runners.md has no heading “nope”",
    ]);
  });

  test("every link in Perch's own docs lands", () => {
    // This is the build gate: a broken link here fails `bun run check`, not somebody's browser.
    expect(checkLinks(pages())).toEqual([]);
  });
});

describe("the sidebar (task 4.7)", () => {
  const all = pages();

  test("holds every page under docs/, so none is reachable only by URL", () => {
    const linked = new Set(sidebar(all).flatMap((group) => group.items.map((item) => item.link)));
    const missing = all.filter((page) => !linked.has(page.route)).map((page) => page.file);
    expect(missing).toEqual([]);
    expect(linked.size).toBe(all.length);
  });

  test("groups the directories, and leads with the index", () => {
    const groups = sidebar(all);
    expect(groups.map((group) => group.label)).toEqual([
      "Perch",
      "The specification",
      "Policies",
      "RFCs",
    ]);
    expect(groups[0]?.items[0]?.link).toBe("/");
  });
});
