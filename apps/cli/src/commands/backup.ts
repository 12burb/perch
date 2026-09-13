/**
 * `perch backup` and `perch restore` for laptop mode (spec §2): a backup is a directory holding the
 * PGlite data dir as a tarball (PGlite's dumpDataDir, consistent because PGlite is single-process),
 * the files dir, the master key, and a manifest. Stop `perch dev` first: PGlite refuses two openers.
 * Team-mode (Postgres) backups are pg_dump plus the files volume (docs/deploy.md).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openPglite } from "@perch/db";
import { dataDirFrom, laptopLayout } from "../paths.ts";

export type Manifest = {
  format: "perch-backup";
  version: 1;
  createdAt: string;
  dataDir: string;
  pglite: string;
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
  const pglite = openPglite(layout.pglite);
  try {
    await pglite.waitReady;
    const dump = await pglite.dumpDataDir("gzip");
    writeFileSync(join(outDir, "pglite.tar.gz"), new Uint8Array(await dump.arrayBuffer()));
  } finally {
    await pglite.close();
  }
  const files = existsSync(layout.files);
  if (files) cpSync(layout.files, join(outDir, "files"), { recursive: true });
  const masterKey = existsSync(layout.masterKey);
  if (masterKey) cpSync(layout.masterKey, join(outDir, "master.key"));
  const manifest: Manifest = {
    format: "perch-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    dataDir: layout.dataDir,
    pglite: "pglite.tar.gz",
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
  if (manifest.format !== "perch-backup" || manifest.version !== 1) {
    throw new Error(`unsupported backup format in ${path}`);
  }
  return manifest as Manifest;
}

export async function restoreBackup(
  backupDir: string,
  dataDir: string,
  options: { force?: boolean } = {},
): Promise<Manifest> {
  const manifest = readManifest(backupDir);
  const layout = laptopLayout(dataDir);
  if (existsSync(layout.pglite) && readdirSync(layout.pglite).length > 0 && !options.force) {
    throw new Error(`${layout.pglite} already holds data; pass --force to replace it`);
  }
  mkdirSync(layout.dataDir, { recursive: true });
  const tarball = readFileSync(join(backupDir, manifest.pglite));
  const target = existsSync(layout.pglite)
    ? `${layout.pglite}.restore-${Date.now()}`
    : layout.pglite;
  const pglite = openPglite(target, { loadDataDir: new Blob([new Uint8Array(tarball)]) });
  try {
    await pglite.waitReady;
    await pglite.query("select 1");
  } finally {
    await pglite.close();
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
      `backup written to ${out}\n  pglite: ${manifest.pglite}\n  files: ${manifest.files}\n  master key: ${manifest.masterKey}`,
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
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help || !positionals[0]) {
    console.log(
      "perch restore <backup-dir> [--data-dir <path>] [--force]   (stop perch dev first)",
    );
    return values.help ? 0 : 2;
  }
  try {
    const manifest = await restoreBackup(resolve(positionals[0]), dataDirFrom(values["data-dir"]), {
      force: values.force ?? false,
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
