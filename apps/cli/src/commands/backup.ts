/**
 * `perch backup` and `perch restore` for laptop mode (spec §2; task 4.4).
 *
 * A backup is a directory with two copies of the same database: `pglite.tar.gz`, which is this
 * data directory byte for byte and restores fastest, and `database.jsonl.gz`, the logical dump
 * `@perch/db` writes, which restores into *any* Perch — including a team instance on Postgres.
 * Beside them are the files directory, the master key, and a manifest.
 *
 * Stop `perch dev` first: PGlite refuses two openers.
 */
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { createGunzip, createGzip } from "node:zlib";
import { createDb, dumpDatabase, linesOf, openPglite, restoreDatabase } from "@perch/db";
import { dataDirFrom, laptopLayout } from "../paths.ts";
import { pgliteRuntime } from "../pglite-runtime.ts";

export type Manifest = {
  format: "perch-backup";
  /** 1 was pglite-only; 2 adds the portable dump beside it. */
  version: 1 | 2;
  createdAt: string;
  dataDir: string;
  pglite: string;
  /** The logical dump, on backups taken by a Perch that writes one. */
  database?: { file: string; tables: number; rows: number };
  files: boolean;
  masterKey: boolean;
};

export async function createBackup(dataDir: string, outDir: string): Promise<Manifest> {
  const layout = laptopLayout(dataDir);
  if (!existsSync(layout.pglite)) throw new Error(`no PGlite data at ${layout.pglite}`);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`${outDir} exists and is not empty`);
  }
  mkdirSync(outDir, { recursive: true });
  const runtime = await pgliteRuntime();
  const pglite = openPglite(layout.pglite, runtime);
  try {
    await pglite.waitReady;
    const dump = await pglite.dumpDataDir("gzip");
    writeFileSync(join(outDir, "pglite.tar.gz"), new Uint8Array(await dump.arrayBuffer()));
  } finally {
    await pglite.close();
  }
  // The portable copy, opened after the first is closed: PGlite allows one opener at a time.
  const handle = await createDb({ url: `pglite://${layout.pglite}`, pglite: runtime });
  let counts = { tables: 0, rows: 0 };
  try {
    const gzip = createGzip();
    const done = pipeline(gzip, createWriteStream(join(outDir, "database.jsonl.gz")));
    counts = await dumpDatabase(handle.db, async (line) => {
      if (!gzip.write(line)) await new Promise<void>((r) => gzip.once("drain", () => r()));
    });
    gzip.end();
    await done;
  } finally {
    await handle.close();
  }
  const files = existsSync(layout.files);
  if (files) cpSync(layout.files, join(outDir, "files"), { recursive: true });
  const masterKey = existsSync(layout.masterKey);
  if (masterKey) cpSync(layout.masterKey, join(outDir, "master.key"));
  const manifest: Manifest = {
    format: "perch-backup",
    version: 2,
    createdAt: new Date().toISOString(),
    dataDir: layout.dataDir,
    pglite: "pglite.tar.gz",
    database: { file: "database.jsonl.gz", tables: counts.tables, rows: counts.rows },
    files,
    masterKey,
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function readManifest(backupDir: string): Manifest {
  const path = join(backupDir, "manifest.json");
  if (!existsSync(path)) throw new Error(`${backupDir} is not a perch backup (no manifest.json)`);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Partial<Manifest>;
  // Version 1 is still read: a backup taken by an older perch is worth more than a clean refusal.
  if (manifest.format !== "perch-backup" || !(manifest.version === 1 || manifest.version === 2)) {
    throw new Error(`unsupported backup format in ${path}`);
  }
  return manifest as Manifest;
}

export async function restoreBackup(
  backupDir: string,
  dataDir: string,
  options: { force?: boolean; portable?: boolean } = {},
): Promise<Manifest> {
  const manifest = readManifest(backupDir);
  const layout = laptopLayout(dataDir);
  if (existsSync(layout.pglite) && readdirSync(layout.pglite).length > 0 && !options.force) {
    throw new Error(`${layout.pglite} already holds data; pass --force to replace it`);
  }
  mkdirSync(layout.dataDir, { recursive: true });
  const runtime = await pgliteRuntime();
  const tarballPath = join(backupDir, manifest.pglite);
  const dumpPath = manifest.database ? join(backupDir, manifest.database.file) : "";
  // The exact copy is the fast path; the portable dump is what a backup from somewhere else has,
  // and what `--portable` asks for on purpose.
  const portable = options.portable === true || !existsSync(tarballPath);
  if (portable && !(dumpPath && existsSync(dumpPath))) {
    throw new Error(`${backupDir} has no portable database dump to restore`);
  }
  const target = existsSync(layout.pglite)
    ? `${layout.pglite}.restore-${Date.now()}`
    : layout.pglite;
  if (portable) {
    // An empty database: the rows go in at the schema they were written at and migrate forward,
    // the same path a team instance takes (ADR-0175).
    const handle = await createDb({ url: `pglite://${target}`, pglite: runtime });
    try {
      const stream = Readable.toWeb(
        createReadStream(dumpPath).pipe(createGunzip()),
      ) as ReadableStream<Uint8Array>;
      await restoreDatabase(handle, linesOf(stream));
    } finally {
      await handle.close();
    }
  } else {
    const tarball = readFileSync(tarballPath);
    const pglite = openPglite(target, {
      ...runtime,
      loadDataDir: new Blob([new Uint8Array(tarball)]),
    });
    try {
      await pglite.waitReady;
      await pglite.query("select 1");
    } finally {
      await pglite.close();
    }
  }
  if (target !== layout.pglite) {
    // Swap the restored directory into place only after it opened cleanly.
    const { renameSync, rmSync } = await import("node:fs");
    rmSync(layout.pglite, { recursive: true, force: true });
    renameSync(target, layout.pglite);
  }
  if (manifest.files && existsSync(join(backupDir, "files"))) {
    cpSync(join(backupDir, "files"), layout.files, { recursive: true, force: true });
  }
  if (manifest.masterKey && existsSync(join(backupDir, "master.key"))) {
    cpSync(join(backupDir, "master.key"), layout.masterKey, { force: true });
  }
  return manifest;
}

export async function runBackup(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "data-dir": { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    console.log("perch backup [<out-dir>] [--data-dir <path>]   (stop perch dev first)");
    return 0;
  }
  const dataDir = dataDirFrom(values["data-dir"]);
  const out = resolve(
    positionals[0] ?? `perch-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  try {
    const manifest = await createBackup(dataDir, out);
    console.log(
      `backup written to ${out}\n  pglite: ${manifest.pglite}\n  database: ${manifest.database?.file ?? "-"} (${manifest.database?.rows ?? 0} rows)\n  files: ${manifest.files}\n  master key: ${manifest.masterKey}`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runRestore(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "data-dir": { type: "string" },
      force: { type: "boolean" },
      /** Restore from the portable dump even when the exact copy is there. */
      portable: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help || !positionals[0]) {
    console.log(
      "perch restore <backup-dir> [--data-dir <path>] [--force] [--portable]   (stop perch dev first)",
    );
    return values.help ? 0 : 2;
  }
  try {
    const manifest = await restoreBackup(resolve(positionals[0]), dataDirFrom(values["data-dir"]), {
      force: values.force ?? false,
      portable: values.portable ?? false,
    });
    console.log(
      `restored the backup from ${manifest.createdAt} into ${dataDirFrom(values["data-dir"])}`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
