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

/** The built web app relative to this source tree (the binary embeds it, task 0.15). */
export function webDistDir(): string {
  return resolve(import.meta.dir, "..", "..", "web", "dist");
}
