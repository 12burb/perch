#!/usr/bin/env bun
/**
 * Performance budgets (spec §4 "Performance", §8 CI "perf audit"): the web bundle and the WebSocket
 * envelope must stay under the budgets below. `bun run perf` fails the build when one is exceeded.
 * The full audit (list virtualization, per-frame batching) is task 2.20; these are its first two gates.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

export const BUDGETS = {
  /** The entry chunk and stylesheet index.html loads before anything renders (gzip). */
  initialGzipKb: 180,
  /** Every JavaScript chunk in dist/assets (gzip); lazy routes included. */
  totalJsGzipKb: 320,
  /** The stylesheet(s) (gzip). */
  cssGzipKb: 48,
  /** One WS envelope for the chattiest event kinds (bytes, UTF-8), payload included. */
  wsEnvelopeBytes: 1024,
} as const;

export type BundleReport = {
  initialGzipKb: number;
  totalJsGzipKb: number;
  cssGzipKb: number;
  files: Array<{ file: string; gzipKb: number }>;
};

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
  const totalJsGzipKb = files
    .filter((f) => f.file.endsWith(".js"))
    .reduce((s, f) => s + f.gzipKb, 0);
  const cssGzipKb = files.filter((f) => f.file.endsWith(".css")).reduce((s, f) => s + f.gzipKb, 0);
  return {
    initialGzipKb: Math.round(initialGzipKb * 10) / 10,
    totalJsGzipKb: Math.round(totalJsGzipKb * 10) / 10,
    cssGzipKb: Math.round(cssGzipKb * 10) / 10,
    files,
  };
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
  check("total js (gzip)", bundle.totalJsGzipKb, BUDGETS.totalJsGzipKb, "KB");
  check("css (gzip)", bundle.cssGzipKb, BUDGETS.cssGzipKb, "KB");
  for (const sample of sampleEnvelopes()) {
    check(`ws envelope ${sample.type}`, sample.bytes, BUDGETS.wsEnvelopeBytes, "B");
  }
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
