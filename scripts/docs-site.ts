#!/usr/bin/env bun
/**
 * The docs site (task 4.7): every Markdown file under `docs/` becomes a page of an Astro Starlight
 * site, with search, a sidebar that cannot miss a page, and a build that fails on a broken link.
 *
 * The documentation stays plain Markdown in the repository — that is what a contributor edits, and
 * what reads well in a pull request — so this is the thin layer between the two: it works out each
 * file's route, rewrites the links between them, checks that every one of them lands somewhere,
 * and writes the content collection and the sidebar the site is built from.
 *
 *   bun scripts/docs-site.ts            # check the links and say what the site would contain
 *   bun scripts/docs-site.ts --sync     # write docs/site/src/content/docs and the sidebar
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

export const ROOT = resolve(import.meta.dir, "..");
export const DOCS = join(ROOT, "docs");
export const SITE = join(DOCS, "site");
/** Where a link that leaves `docs/` goes instead: the file on GitHub. */
export const REPO_BLOB = "https://github.com/12burb/perch/blob/main";

export type Page = {
  /** Path relative to `docs/`, e.g. `spec/PERCH-SPEC.md`. */
  file: string;
  /** The site route, always with a trailing slash: `/`, `/deploy/`, `/spec/perch-spec/`. */
  route: string;
  /** Where the content collection file goes, relative to `src/content/docs`. */
  slugPath: string;
  title: string;
  description: string;
  /** The top-level directory, or "" for the pages at the root of `docs/`. */
  group: string;
  /** Every heading's anchor, so a link to `#something` can be checked. */
  anchors: Set<string>;
  markdown: string;
};

/** GitHub's heading slugs, which is what Starlight's autolinked headings use too. */
export function slugOf(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`|\*|_|~/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\w\- ]+/g, "")
    .replace(/\s+/g, "-");
}

/** `deploy.md` → `/deploy/`; `README.md` → `/`; `spec/PERCH-SPEC.md` → `/spec/perch-spec/`. */
export function routeOf(file: string): string {
  const parts = file.replace(/\.md$/, "").split("/");
  const last = parts.pop() ?? "";
  const lowered = [...parts.map((part) => part.toLowerCase()), last.toLowerCase()];
  if (last.toLowerCase() === "readme") lowered.pop();
  const path = lowered.filter(Boolean).join("/");
  return path ? `/${path}/` : "/";
}

function walk(dir: string, base = dir): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `site/` is the generated project itself; nothing in it is a source page.
    if (entry.name === "site" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, base));
    else if (entry.name.endsWith(".md")) found.push(relative(base, full));
  }
  return found.sort();
}

function firstParagraph(markdown: string): string {
  const body = markdown.replace(/^#[^\n]*\n/, "");
  for (const block of body.split("\n\n")) {
    const text = block.trim();
    if (!text || text.startsWith("#") || text.startsWith("|") || text.startsWith(">")) continue;
    if (text.startsWith("```")) continue;
    const flat = text
      .replace(/\n/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_]/g, "");
    return flat.length > 160 ? `${flat.slice(0, 157).trimEnd()}…` : flat;
  }
  return "";
}

/** Every page of the site, in the order the index lists them and then alphabetically. */
export function pages(docs = DOCS): Page[] {
  const files = walk(docs);
  const found = files.map((file): Page => {
    const markdown = readFileSync(join(docs, file), "utf8");
    const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? "";
    const anchors = new Set<string>();
    for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
      anchors.add(slugOf(match[1] ?? ""));
    }
    const route = routeOf(file);
    return {
      file,
      route,
      slugPath: route === "/" ? "index.md" : `${route.slice(1, -1)}.md`,
      title: heading || (file.split("/").pop() ?? file).replace(/\.md$/, ""),
      description: firstParagraph(markdown),
      group: file.includes("/") ? (file.split("/")[0] ?? "") : "",
      anchors,
      markdown,
    };
  });
  // The index's own order is the order somebody chose; everything else follows it.
  const index = found.find((page) => page.file === "README.md");
  const preferred = [
    ...(index?.markdown.matchAll(/\]\((?!https?:)([^)#]+\.md)[^)]*\)/g) ?? []),
  ].map((match) => (match[1] ?? "").replace(/^\.\//, ""));
  const rank = (page: Page) => {
    const at = preferred.indexOf(page.file);
    return at === -1 ? preferred.length + 1 : at;
  };
  return found.sort((a, b) => {
    if (a.file === "README.md") return -1;
    if (b.file === "README.md") return 1;
    const byIndex = rank(a) - rank(b);
    return byIndex === 0 ? a.file.localeCompare(b.file) : byIndex;
  });
}

export type LinkProblem = { file: string; link: string; why: string };

/** Every markdown link in a page, with its target resolved relative to the page's own directory. */
function linksOf(page: Page): { raw: string; target: string; anchor: string }[] {
  const links: { raw: string; target: string; anchor: string }[] = [];
  for (const match of page.markdown.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = match[1] ?? "";
    if (!raw || /^(https?:|mailto:|#)/.test(raw)) continue;
    const [path = "", anchor = ""] = raw.split("#");
    links.push({ raw, target: path, anchor });
  }
  return links;
}

/** What `./foo.md#bar` in this page points at, as a path relative to `docs/`. */
function resolveTarget(page: Page, target: string): string {
  return join(dirname(page.file), target).replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Checks every internal link: a `.md` target must be a page the site has, an anchor must be a
 * heading on it, and anything outside `docs/` must be a file that exists in the repository.
 */
export function checkLinks(all: Page[], root = ROOT): LinkProblem[] {
  const byFile = new Map(all.map((page) => [page.file, page]));
  const problems: LinkProblem[] = [];
  for (const page of all) {
    for (const link of linksOf(page)) {
      const resolved = resolveTarget(page, link.target);
      if (resolved.startsWith("..")) {
        // Out of `docs/`: it becomes a GitHub link, so the file has to be there.
        const path = join(DOCS, resolved);
        if (!existsSync(path)) {
          problems.push({ file: page.file, link: link.raw, why: "no such file in the repository" });
        }
        continue;
      }
      if (!link.target.endsWith(".md")) {
        // An image or another asset, kept beside the docs.
        if (!existsSync(join(DOCS, resolved))) {
          problems.push({ file: page.file, link: link.raw, why: "no such file under docs/" });
        }
        continue;
      }
      const target = byFile.get(resolved);
      if (!target) {
        problems.push({ file: page.file, link: link.raw, why: "no page with that path" });
        continue;
      }
      if (link.anchor && !target.anchors.has(link.anchor)) {
        problems.push({
          file: page.file,
          link: link.raw,
          why: `${resolved} has no heading “${link.anchor}”`,
        });
      }
    }
  }
  void root;
  return problems;
}

/** The markdown a page ships with: links between docs become routes, the rest go to GitHub. */
export function rewrite(page: Page, all: Page[]): string {
  const byFile = new Map(all.map((one) => [one.file, one]));
  return page.markdown.replace(
    /\]\(([^)\s]+)(\s+"[^"]*")?\)/g,
    (whole, raw: string, title = "") => {
      if (!raw || /^(https?:|mailto:|#)/.test(raw)) return whole;
      const [path = "", anchor = ""] = raw.split("#");
      const resolved = resolveTarget(page, path);
      const suffix = anchor ? `#${anchor}` : "";
      if (resolved.startsWith("..")) {
        const outside = resolved.replace(/^(\.\.\/)+/, "");
        return `](${REPO_BLOB}/${outside}${suffix}${title})`;
      }
      const target = byFile.get(resolved);
      if (!target) return `](${resolved}${suffix}${title})`;
      return `](${target.route}${suffix}${title})`;
    },
  );
}

export type SidebarGroup = { label: string; items: { label: string; link: string }[] };

/** One group per directory, in the index's order; the pages at the root of `docs/` come first. */
export function sidebar(all: Page[]): SidebarGroup[] {
  const labels: Record<string, string> = {
    "": "Perch",
    policies: "Policies",
    rfcs: "RFCs",
    spec: "The specification",
  };
  const groups = new Map<string, SidebarGroup>();
  for (const page of all) {
    const key = page.group;
    const group = groups.get(key) ?? {
      label: labels[key] ?? key.replace(/^\w/, (c) => c.toUpperCase()),
      items: [],
    };
    group.items.push({ label: page.title, link: page.route });
    groups.set(key, group);
  }
  return [...groups.values()];
}

function frontmatter(page: Page): string {
  const quoted = (text: string) => text.replace(/"/g, '\\"');
  const lines = [`title: "${quoted(page.title)}"`];
  if (page.description) lines.push(`description: "${quoted(page.description)}"`);
  // The page's own H1 becomes the site's title, so it is dropped from the body.
  return `---\n${lines.join("\n")}\n---\n`;
}

/** Writes the content collection and the sidebar; returns what it wrote. */
export function sync(all: Page[], site = SITE): { files: number; groups: number } {
  const content = join(site, "src", "content", "docs");
  rmSync(content, { recursive: true, force: true });
  for (const page of all) {
    const out = join(content, page.slugPath);
    mkdirSync(dirname(out), { recursive: true });
    const body = rewrite(page, all).replace(/^#\s+.+\n+/, "");
    writeFileSync(out, `${frontmatter(page)}\n${body}`);
  }
  const groups = sidebar(all);
  writeFileSync(join(site, "src", "sidebar.json"), `${JSON.stringify(groups, null, 2)}\n`);
  return { files: all.length, groups: groups.length };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { sync: { type: "boolean" }, quiet: { type: "boolean" } },
  });
  const all = pages();
  const problems = checkLinks(all);
  for (const problem of problems) {
    console.error(`broken link  ${problem.file}: ${problem.link} — ${problem.why}`);
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} broken link${problems.length === 1 ? "" : "s"}.`);
    process.exit(1);
  }
  if (values.sync) {
    const written = sync(all);
    console.log(`docs site: ${written.files} pages in ${written.groups} groups, links all land`);
  } else if (!values.quiet) {
    console.log(`docs site: ${all.length} pages, links all land`);
    for (const group of sidebar(all)) {
      console.log(`  ${group.label}: ${group.items.length}`);
    }
  }
}
