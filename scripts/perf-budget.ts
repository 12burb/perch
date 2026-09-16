#!/usr/bin/env bun
/**
 * Performance budgets (spec §4 "Performance", §8 CI "perf audit"; task 2.20): the web bundle, the
 * WebSocket envelope, and every long list. `bun run perf` fails the build when one is exceeded.
 *
 * The list check is the third gate and works differently from the other two. There is no number to
 * measure: ground rule 7 says "every long list is virtualized", and what makes that true is a
 * decision per surface. So every list surface is registered below with how it is kept short —
 * virtualized, or capped somewhere the check can read — and a net catches a new scrolling list that
 * nobody registered.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

export const BUDGETS = {
  /** The entry chunk and stylesheet index.html loads before anything renders (gzip). */
  initialGzipKb: 180,
  /**
   * The app's own JavaScript (gzip): the entry, everything it imports, and every route chunk the
   * app itself splits off (ADR-0072). Since the editor (task 1.6) it carries CodeMirror's core and
   * since the terminal (task 1.7, ADR-0073) xterm.js, loaded with the drawer. Raised to 600 in
   * task 2.14 (ADR-0104): this number grows with the number of screens, which is the wrong thing
   * for a budget to fight; `initialGzipKb` is the one that guards the first paint.
   */
  appJsGzipKb: 600,
  /**
   * On-demand library packs (gzip): chunks a library loads lazily on its own, one per file type
   * (CodeMirror's ~40 language grammars behind @codemirror/language-data); a user downloads only
   * the ones for the files they open.
   */
  packsJsGzipKb: 480,
  /** The stylesheet(s) (gzip). */
  cssGzipKb: 48,
  /** One WS envelope for the chattiest event kinds (bytes, UTF-8), payload included. */
  wsEnvelopeBytes: 1024,
} as const;

export type BundleReport = {
  initialGzipKb: number;
  /** appJsGzipKb + packsJsGzipKb. */
  totalJsGzipKb: number;
  appJsGzipKb: number;
  packsJsGzipKb: number;
  cssGzipKb: number;
  files: Array<{ file: string; gzipKb: number }>;
};

type ManifestChunk = {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
};

/**
 * The chunks the app itself reaches from Vite's manifest: static imports always, dynamic imports
 * only when the target is app code (a route under src/), so a library's own lazy packs (targets
 * under node_modules) stay apart. Without a manifest every chunk counts as the app's.
 */
export function appChunks(dist: string): Set<string> | null {
  const manifestPath = join(dist, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ManifestChunk>;
  const reached = new Set<string>();
  const seen = new Set<string>();
  const stack = Object.keys(manifest).filter((key) => manifest[key]?.isEntry);
  while (stack.length > 0) {
    const key = stack.pop();
    if (key === undefined || seen.has(key)) continue;
    const chunk = manifest[key];
    if (!chunk) continue;
    seen.add(key);
    reached.add(chunk.file);
    stack.push(...(chunk.imports ?? []));
    for (const target of chunk.dynamicImports ?? []) {
      if (!target.includes("node_modules")) stack.push(target);
    }
  }
  return reached;
}

function gzipKb(bytes: Uint8Array): number {
  return Math.round((gzipSync(bytes).byteLength / 1024) * 10) / 10;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/** Measures a Vite dist directory. */
export function measureBundle(dist: string): BundleReport {
  const index = readFileSync(join(dist, "index.html"), "utf8");
  const initialRefs = [...index.matchAll(/(?:src|href)="\/?([^"]+\.(?:js|css))"/g)].map(
    (m) => m[1] ?? "",
  );
  const files = walk(dist)
    .filter((f) => /\.(js|css)$/.test(f))
    .map((f) => ({
      // Forward slashes on every platform so the keys match the references in index.html.
      file: f.slice(dist.length + 1).replace(/\\/g, "/"),
      gzipKb: gzipKb(readFileSync(f)),
    }))
    .sort((a, b) => b.gzipKb - a.gzipKb);
  const byFile = new Map(files.map((f) => [f.file, f.gzipKb]));
  const initialGzipKb = initialRefs.reduce((sum, ref) => sum + (byFile.get(ref) ?? 0), 0);
  const app = appChunks(dist);
  const js = files.filter((f) => f.file.endsWith(".js"));
  const appJsGzipKb = js
    .filter((f) => app === null || app.has(f.file))
    .reduce((s, f) => s + f.gzipKb, 0);
  const packsJsGzipKb = js
    .filter((f) => app !== null && !app.has(f.file))
    .reduce((s, f) => s + f.gzipKb, 0);
  const cssGzipKb = files.filter((f) => f.file.endsWith(".css")).reduce((s, f) => s + f.gzipKb, 0);
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    initialGzipKb: round(initialGzipKb),
    totalJsGzipKb: round(appJsGzipKb + packsJsGzipKb),
    appJsGzipKb: round(appJsGzipKb),
    packsJsGzipKb: round(packsJsGzipKb),
    cssGzipKb: round(cssGzipKb),
    files,
  };
}

/**
 * The message-catalog fragments (ADR-0085) and the keys each one owns. A fragment ships with the
 * route chunk that imports it, so none of its keys may appear in the entry: a key that does means
 * either a shell string was filed under a route, or a route's fragment was dragged into the first
 * paint. Both put bytes in front of the first render, which is what the budget is for.
 */
export function fragmentKeysInEntry(dist: string, i18nDir: string): string[] {
  const index = readFileSync(join(dist, "index.html"), "utf8");
  const entryRef = [...index.matchAll(/src="\/?([^"]+\.js)"/g)].map((m) => m[1] ?? "")[0];
  if (!entryRef) return [];
  const entryPath = join(dist, entryRef);
  if (!existsSync(entryPath)) return [];
  const entry = readFileSync(entryPath, "utf8");
  const found: string[] = [];
  for (const file of readdirSync(i18nDir)) {
    // en.json is the core catalog; en.<fragment>.json is a route's own.
    if (!/^en\.[a-z]+\.json$/.test(file)) continue;
    const keys = Object.keys(
      JSON.parse(readFileSync(join(i18nDir, file), "utf8")) as Record<string, string>,
    );
    for (const key of keys) if (entry.includes(`"${key}"`)) found.push(`${file}: ${key}`);
  }
  return found;
}

/** Representative envelopes for the chattiest §7.7 events, as the WS server sends them. */
export function sampleEnvelopes(): Array<{ type: string; bytes: number }> {
  const ws = "0190f2d0-1234-7000-8000-000000000001";
  const user = "0190f2d0-1234-7000-8000-0000000000aa";
  const channel = "0190f2d0-1234-7000-8000-0000000000cc";
  const ts = "2026-09-13T12:00:00.000Z";
  const envelope = (type: string, payload: unknown, topic = `ws:${ws}`) =>
    JSON.stringify({ type, topic, seq: 123456, ts, payload });
  const samples = [
    envelope("presence.changed", { workspaceId: ws, userId: user, status: "online" }),
    envelope(
      "typing",
      { workspaceId: ws, channelId: channel, memberType: "user", memberId: user },
      `channel:${channel}`,
    ),
    envelope(
      "message.created",
      {
        workspaceId: ws,
        channelId: channel,
        messageId: user,
        authorType: "user",
        authorId: user,
        threadRootId: channel,
      },
      `channel:${channel}`,
    ),
    envelope(
      "session.delta",
      {
        workspaceId: ws,
        sessionId: channel,
        turn: 12,
        delta: { kind: "text", text: "x".repeat(400) },
      },
      `session:${channel}`,
    ),
  ];
  return samples.map((s) => ({
    type: (JSON.parse(s) as { type: string }).type,
    bytes: Buffer.byteLength(s),
  }));
}

/**
 * Every list of rows Perch renders from server data, and what keeps it short. A surface is either
 * `virtualized` (it renders a window) or `capped` (something the check can read limits the rows).
 *
 * Adding a screen with a long list means adding a line here. The net below makes that hard to
 * forget: a file with a scroll container and a `.map(` that is not registered fails the audit.
 */
export const LIST_SURFACES = [
  { file: "apps/web/src/chat/transcript.tsx", list: "a channel's messages", how: "virtualized" },
  {
    file: "apps/web/src/chat/search.tsx",
    list: "search results, in every lane",
    how: "virtualized",
  },
  {
    file: "apps/web/src/chat/channels.tsx",
    list: "every channel in the workspace, in Home",
    how: "virtualized",
  },
  { file: "apps/web/src/code/file-tree.tsx", list: "a project's files", how: "virtualized" },
  {
    file: "apps/web/src/code/git-panel.tsx",
    list: "what changed, before a commit",
    how: "virtualized",
  },
  {
    file: "packages/ui/src/components/diff-view.tsx",
    list: "a diff's files, hunks and lines",
    how: "virtualized",
  },
  {
    file: "packages/ui/src/components/session-transcript.tsx",
    list: "a session's turns and tool calls",
    how: "virtualized",
  },
  {
    file: "packages/ui/src/components/virtual-list.tsx",
    list: "the window the lists above render through",
    how: "virtualized",
  },
  {
    file: "packages/ui/src/components/inbox-list.tsx",
    list: "what needs you",
    how: { capped: 100, in: "apps/web/src/lib/queries.ts", proof: "limit: 100" },
  },
  {
    file: "apps/web/src/inbox/inbox.tsx",
    list: "the inbox's own scroller around that list",
    how: { capped: 100, in: "apps/web/src/lib/queries.ts", proof: "limit: 100" },
  },
  {
    file: "apps/web/src/code/sessions-list.tsx",
    list: "a project's sessions, in the sidebar",
    how: { capped: 100, in: "apps/api/src/repos/sessions.ts", proof: "limit = 100" },
  },
  {
    file: "apps/web/src/code/inspector.tsx",
    list: "the console strip and the elements tree",
    how: { capped: 10, in: "apps/web/src/code/inspector.tsx", proof: "slice(-10)" },
  },
  {
    file: "packages/ui/src/shell/composer.tsx",
    list: "the mention autocomplete",
    how: { capped: 8, in: "packages/ui/src/shell/composer.tsx", proof: "slice(0, 8)" },
  },
  {
    file: "packages/ui/src/shell/command-palette.tsx",
    list: "⌘K's commands, per group",
    how: {
      capped: 50,
      in: "packages/ui/src/shell/command-palette.tsx",
      proof: "PALETTE_SHOWN = 50",
    },
  },
  {
    file: "apps/web/src/chat/channels.tsx#sidebar",
    list: "the sidebar's channels, DMs and bots",
    how: { capped: 30, in: "apps/web/src/chat/channels.tsx", proof: "SIDEBAR_ROWS = 30" },
  },
  {
    file: "apps/web/src/code/preview-pane.tsx",
    list: "a preview's ports and share links",
    how: {
      bounded:
        "the ports a dev server opened, and the share links a person made one at a time — neither grows with the workspace",
    },
  },
  {
    file: "packages/ui/src/components/editor-group.tsx",
    list: "the editor's open tabs",
    how: { bounded: "one per file the person opened; nothing but a click adds to it" },
  },
  {
    file: "packages/ui/src/shell/drawer.tsx",
    list: "the drawer's tabs",
    how: { bounded: "the fixed set Code mode passes in: terminal, console, git, problems" },
  },
] as const;

type Surface = (typeof LIST_SURFACES)[number];

/** Where a component that renders rows can live. */
const UI_ROOTS = ["apps/web/src", "packages/ui/src"] as const;

/** A file that scrolls. Anything with its own scroll container can hold an unbounded list. */
const SCROLLS = /overflow-y-auto|overflow-auto/;

function tsxFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      tsxFiles(path, out);
    } else if (entry.endsWith(".tsx") && !entry.includes(".ct.") && !entry.includes(".demo.")) {
      out.push(path);
    }
  }
  return out;
}

export type ListFinding = { file: string; problem: string };

/**
 * Ground rule 7, as a check. Every registered surface must still do what it says, and no
 * unregistered file may render a list inside its own scroll container.
 */
export function listVirtualization(root: string): ListFinding[] {
  const findings: ListFinding[] = [];
  // A file may hold two surfaces (Home's channel list and the sidebar's); `file.tsx#sidebar` names
  // the second one without pretending there are two files.
  const read = (relative: string): string | null => {
    const path = join(root, relative.split("#")[0] ?? relative);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  for (const surface of LIST_SURFACES as readonly Surface[]) {
    const source = read(surface.file);
    if (source === null) {
      findings.push({ file: surface.file, problem: "registered but not in the repository" });
      continue;
    }
    if (surface.how === "virtualized") {
      const virtual = source.includes("useVirtualizer(") || source.includes("<VirtualList");
      if (!virtual) {
        findings.push({
          file: surface.file,
          problem: `${surface.list}: registered as virtualized but renders every row`,
        });
      }
      continue;
    }
    // A reasoned exemption: the list grows with what one person did, not with the workspace.
    if ("bounded" in surface.how) continue;
    const proof = read(surface.how.in);
    if (proof === null || !proof.includes(surface.how.proof)) {
      findings.push({
        file: surface.file,
        problem: `${surface.list}: the cap of ${surface.how.capped} is gone from ${surface.how.in} (looked for \`${surface.how.proof}\`)`,
      });
    }
  }
  const registered = new Set<string>(
    LIST_SURFACES.map((one) => one.file.split("#")[0] ?? one.file),
  );
  for (const dir of UI_ROOTS) {
    for (const path of tsxFiles(join(root, dir))) {
      const relative = path.slice(root.length + 1);
      if (registered.has(relative)) continue;
      const source = readFileSync(path, "utf8");
      if (!SCROLLS.test(source) || !source.includes(".map(")) continue;
      findings.push({
        file: relative,
        problem: "renders a list inside its own scroll container but is not a registered surface",
      });
    }
  }
  return findings;
}

export type PerfResult = { ok: boolean; lines: string[] };

export function audit(dist: string): PerfResult {
  const lines: string[] = [];
  let ok = true;
  const check = (name: string, value: number, budget: number, unit: string) => {
    const pass = value <= budget;
    ok &&= pass;
    lines.push(
      `${pass ? "ok  " : "FAIL"}  ${name.padEnd(28)} ${value} ${unit} (budget ${budget} ${unit})`,
    );
  };
  if (!existsSync(join(dist, "index.html"))) {
    return {
      ok: false,
      lines: [`FAIL  web build missing at ${dist} (bun run --filter @perch/web build)`],
    };
  }
  const bundle = measureBundle(dist);
  check("initial js+css (gzip)", bundle.initialGzipKb, BUDGETS.initialGzipKb, "KB");
  check("app js (gzip)", bundle.appJsGzipKb, BUDGETS.appJsGzipKb, "KB");
  check("on-demand packs js (gzip)", bundle.packsJsGzipKb, BUDGETS.packsJsGzipKb, "KB");
  lines.push(`info  ${"total js (gzip)".padEnd(28)} ${bundle.totalJsGzipKb} KB`);
  check("css (gzip)", bundle.cssGzipKb, BUDGETS.cssGzipKb, "KB");
  const i18nDir = resolve(import.meta.dir, "..", "packages", "ui", "src", "i18n");
  if (existsSync(i18nDir)) {
    const leaked = fragmentKeysInEntry(dist, i18nDir);
    ok &&= leaked.length === 0;
    lines.push(
      `${leaked.length === 0 ? "ok  " : "FAIL"}  ${"i18n fragments out of entry".padEnd(28)} ${leaked.length} leaked (budget 0 leaked)`,
    );
    for (const leak of leaked.slice(0, 10)) lines.push(`        ${leak}`);
  }
  for (const sample of sampleEnvelopes()) {
    check(`ws envelope ${sample.type}`, sample.bytes, BUDGETS.wsEnvelopeBytes, "B");
  }
  const root = resolve(import.meta.dir, "..");
  const listFindings = listVirtualization(root);
  ok &&= listFindings.length === 0;
  lines.push(
    `${listFindings.length === 0 ? "ok  " : "FAIL"}  ${"long lists".padEnd(28)} ${LIST_SURFACES.length} surfaces, ${listFindings.length} unbounded (budget 0)`,
  );
  for (const finding of listFindings) lines.push(`        ${finding.file}: ${finding.problem}`);
  lines.push("", "largest chunks:");
  for (const f of bundle.files.slice(0, 5))
    lines.push(`  ${f.gzipKb.toString().padStart(7)} KB  ${f.file}`);
  return { ok, lines };
}

if (import.meta.main) {
  const dist = resolve(process.argv[2] ?? resolve(import.meta.dir, "..", "apps", "web", "dist"));
  const result = audit(dist);
  console.log(result.lines.join("\n"));
  process.exit(result.ok ? 0 : 1);
}
