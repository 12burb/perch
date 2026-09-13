import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Laptop-mode layout under the data dir (default ~/.perch): data/ (PGlite), files/, master.key. */
export function expandHome(path: string): string {
  return path.startsWith("~") ? `${homedir()}${path.slice(1)}` : path;
}

export function dataDirFrom(flag: string | undefined): string {
  return resolve(expandHome(flag ?? process.env.PERCH_DATA_DIR ?? "~/.perch"));
}

export function laptopLayout(dataDir: string) {
  return {
    dataDir,
    pglite: join(dataDir, "data"),
    files: join(dataDir, "files"),
    masterKey: join(dataDir, "master.key"),
    databaseUrl: `pglite://${join(dataDir, "data")}`,
  };
}

/**
 * Where the built web app lives: PERCH_WEB_DIST, the source tree (apps/web/dist), or `web/` next to
 * the bundled npm script. The compiled binary embeds the app instead (web-assets.gen.ts, ADR-0060).
 */
export function webDistDir(): string {
  const candidates = [
    process.env.PERCH_WEB_DIST,
    resolve(import.meta.dir, "..", "..", "web", "dist"),
    resolve(import.meta.dir, "web"),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  return (
    candidates.find((c) => existsSync(join(c, "index.html"))) ??
    candidates[1] ??
    candidates[0] ??
    ""
  );
}
