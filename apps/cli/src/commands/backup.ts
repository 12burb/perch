/**
 * `perch backup` and `perch restore` for laptop mode (spec §2; task 4.4).
 *
 * A backup is the same directory a team instance writes (`perch-instance-backup`, ADR-0175): the
 * logical dump `database.jsonl.gz`, which restores into *any* Perch, the files directory, and a
 * manifest — plus `pglite.tar.gz`, this data directory byte for byte, which `perch restore`
 * prefers because it is the fastest way back. A team instance restores a laptop backup from its
 * dump, and `perch restore` restores a team backup the same way.
 *
 * The vault key is fingerprinted, not copied, unless `--include-key` (or
 * PERCH_BACKUP_INCLUDE_KEY=on) says otherwise: with it the backup unlocks every credential in it.
 *
 * Both take the data directory's lock (ADR-0175): a running `perch dev` has the database open,
 * and a second opener would overwrite its committed work. Stop it first.
 */
import {
  chmodSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  type BackupManifest,
  DUMP_FILE,
  fingerprintKey,
  readManifest,
  sizeOf,
} from "@perch/api/services/backups";
import {
  createDb,
  dumpGzipped,
  embeddedMigrations,
  linesOf,
  openPglite,
  restoreDatabase,
} from "@perch/db";
import { lockDataDir } from "../data-lock.ts";
import { dataDirFrom, laptopLayout } from "../paths.ts";
import { pgliteRuntime } from "../pglite-runtime.ts";
import { CLI_VERSION } from "../version.ts";

/** The exact copy's name inside a backup. */
const PGLITE_FILE = "pglite.tar.gz";

/** `on`, `true`, `1` or `yes`, as the api reads PERCH_BACKUP_INCLUDE_KEY. */
function flagOn(value: string | undefined): boolean {
  return /^(on|true|1|yes)$/i.test(value?.trim() ?? "");
}

/** The key this data directory's instance runs with: PERCH_MASTER_KEY, or the generated file. */
function instanceKey(layout: ReturnType<typeof laptopLayout>): string | null {
  const fromEnv = process.env.PERCH_MASTER_KEY?.trim();
  if (fromEnv) return fromEnv;
  return existsSync(layout.masterKey) ? readFileSync(layout.masterKey, "utf8").trim() : null;
}

export async function createBackup(
  dataDir: string,
  outDir: string,
  options: { includeKey?: boolean } = {},
): Promise<BackupManifest> {
  const layout = laptopLayout(dataDir);
  if (!existsSync(layout.pglite)) throw new Error(`no PGlite data at ${layout.pglite}`);
  const existed = existsSync(outDir);
  if (existed && readdirSync(outDir).length > 0) {
    throw new Error(`${outDir} exists and is not empty`);
  }
  const includeKey = options.includeKey ?? flagOn(process.env.PERCH_BACKUP_INCLUDE_KEY);
  const lock = lockDataDir(layout.dataDir, "perch backup");
  try {
    // Everything in here is as sensitive as the instance: only its owner reads it.
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    if (!existed) chmodSync(outDir, 0o700);
    const runtime = await pgliteRuntime();
    const pglite = openPglite(layout.pglite, runtime);
    try {
      await pglite.waitReady;
      const dump = await pglite.dumpDataDir("gzip");
      writeFileSync(join(outDir, PGLITE_FILE), new Uint8Array(await dump.arrayBuffer()), {
        mode: 0o600,
      });
    } finally {
      await pglite.close();
    }
    // The portable copy, opened after the first is closed: PGlite allows one opener at a time.
    const handle = await createDb({ url: layout.databaseUrl, pglite: runtime });
    let counts: Awaited<ReturnType<typeof dumpGzipped>>;
    try {
      counts = await dumpGzipped(
        handle.db,
        createWriteStream(join(outDir, DUMP_FILE), { mode: 0o600 }),
      );
    } finally {
      await handle.close();
    }
    const files = sizeOf(layout.files);
    if (files.count > 0) cpSync(layout.files, join(outDir, "files"), { recursive: true });
    const key = instanceKey(layout);
    if (includeKey && key) {
      writeFileSync(join(outDir, "master.key"), `${key}\n`, { mode: 0o600 });
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      perchVersion: CLI_VERSION,
      mode: "laptop",
      driver: "pglite",
      database: {
        file: DUMP_FILE,
        tables: counts.tables,
        rows: counts.rows,
        bytes: sizeOf(join(outDir, DUMP_FILE)).bytes,
        migrations: counts.migrations,
      },
      files: { dir: "files", count: files.count, bytes: files.bytes },
      masterKey: {
        included: includeKey && key !== null,
        fingerprint: key ? fingerprintKey(key) : "",
      },
      projects: null,
      pglite: PGLITE_FILE,
    };
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (error) {
    // A half-written backup is worse than none: it would be the one restored from.
    if (existed) {
      for (const entry of readdirSync(outDir))
        rmSync(join(outDir, entry), { recursive: true, force: true });
    } else {
      rmSync(outDir, { recursive: true, force: true });
    }
    throw error;
  } finally {
    lock.release();
  }
}

/** What a restore needs from a backup, whichever Perch wrote it. */
type Source = {
  createdAt: string;
  /** The exact copy, when the backup has one (laptop backups). */
  pglite: string | null;
  /** The portable dump, and the schema its rows were read at when the manifest says. */
  dump: string | null;
  migrations: number | null;
  files: string | null;
  key: { included: boolean; fingerprint: string };
};

/** A name inside the backup, as the instance manifest's reader checks its own. */
const INSIDE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The oldest laptop backups (`perch-backup` version 1) had only the exact copy; the instance
 * reader refuses them, and they are read here. Everything else goes through `readManifest`.
 */
function readSource(backupDir: string): Source {
  const path = join(backupDir, "manifest.json");
  if (!existsSync(path)) throw new Error(`${backupDir} is not a perch backup (no manifest.json)`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${backupDir} is not a perch backup (manifest.json is not JSON)`);
  }
  const old = raw as { format?: unknown; version?: unknown; createdAt?: unknown; pglite?: unknown };
  if (old.format === "perch-backup" && old.version === 1) {
    const fields = raw as { files?: unknown; masterKey?: unknown };
    if (
      typeof old.createdAt !== "string" ||
      typeof old.pglite !== "string" ||
      !INSIDE.test(old.pglite)
    ) {
      throw new Error(`unsupported backup format in ${path}`);
    }
    const included = fields.masterKey === true && existsSync(join(backupDir, "master.key"));
    return {
      createdAt: old.createdAt,
      pglite: old.pglite,
      dump: null,
      migrations: null,
      files: fields.files === true ? "files" : null,
      key: {
        included,
        fingerprint: included
          ? fingerprintKey(readFileSync(join(backupDir, "master.key"), "utf8").trim())
          : "",
      },
    };
  }
  const manifest = readManifest(backupDir);
  return {
    createdAt: manifest.createdAt,
    pglite: manifest.pglite ?? null,
    dump: manifest.database.file,
    migrations: manifest.database.migrations ?? null,
    files: manifest.files.dir,
    key: manifest.masterKey,
  };
}

export type RestoreOutcome = {
  createdAt: string;
  /** Which copy was loaded. */
  from: "exact" | "portable";
  /** Whether the backup carried the vault key, which is now this data directory's key. */
  keyRestored: boolean;
  /**
   * Whether this data directory's key is the one the backup's credentials were sealed with; null
   * when either side does not say (no fingerprint in the backup, or no key here yet).
   */
  keyMatches: boolean | null;
};

export async function restoreBackup(
  backupDir: string,
  dataDir: string,
  options: { force?: boolean; portable?: boolean } = {},
): Promise<RestoreOutcome> {
  const source = readSource(backupDir);
  const layout = laptopLayout(dataDir);
  const lock = lockDataDir(layout.dataDir, "perch restore");
  try {
    if (existsSync(layout.pglite) && readdirSync(layout.pglite).length > 0 && !options.force) {
      throw new Error(`${layout.pglite} already holds data; pass --force to replace it`);
    }
    const runtime = await pgliteRuntime();
    const tarballPath = source.pglite ? join(backupDir, source.pglite) : "";
    const dumpPath = source.dump ? join(backupDir, source.dump) : "";
    // The exact copy is the fast path; the portable dump is what a backup from somewhere else has,
    // and what `--portable` asks for on purpose.
    const portable = options.portable === true || !(tarballPath && existsSync(tarballPath));
    if (portable && !(dumpPath && existsSync(dumpPath))) {
      throw new Error(`${backupDir} has no portable database dump to restore`);
    }
    const current = embeddedMigrations().length;
    if (!portable && source.migrations !== null && source.migrations > current) {
      // The exact copy of a newer schema would open, and this build would then run against
      // tables it does not know. The dump's own check refuses the portable path the same way.
      throw new Error(
        `this backup was taken at schema ${source.migrations}, by a newer Perch than this one (schema ${current}); restore it with that release or a later one`,
      );
    }
    const target = existsSync(layout.pglite)
      ? `${layout.pglite}.restore-${Date.now()}`
      : layout.pglite;
    try {
      if (portable) {
        // An empty database: the rows go in at the schema they were written at and migrate
        // forward, the same path a team instance takes (ADR-0175).
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
    } catch (error) {
      if (target !== layout.pglite) rmSync(target, { recursive: true, force: true });
      throw error;
    }
    if (target !== layout.pglite) {
      // Swap the restored directory into place only after it opened cleanly.
      rmSync(layout.pglite, { recursive: true, force: true });
      renameSync(target, layout.pglite);
    }
    if (source.files && existsSync(join(backupDir, source.files))) {
      cpSync(join(backupDir, source.files), layout.files, { recursive: true, force: true });
    }
    const keyFile = join(backupDir, "master.key");
    const keyRestored = source.key.included && existsSync(keyFile);
    if (keyRestored) {
      writeFileSync(layout.masterKey, `${readFileSync(keyFile, "utf8").trim()}\n`, { mode: 0o600 });
    }
    const here = instanceKey(layout);
    const keyMatches =
      source.key.fingerprint && here ? source.key.fingerprint === fingerprintKey(here) : null;
    return {
      createdAt: source.createdAt,
      from: portable ? "portable" : "exact",
      keyRestored,
      keyMatches,
    };
  } finally {
    lock.release();
  }
}

export async function runBackup(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "data-dir": { type: "string" },
      "include-key": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    console.log(
      "perch backup [<out-dir>] [--data-dir <path>] [--include-key]   (stop perch dev first)\n" +
        "  --include-key   write the vault key into the backup (also PERCH_BACKUP_INCLUDE_KEY=on);\n" +
        "                  without it the backup records the key's fingerprint, and you keep the key",
    );
    return 0;
  }
  const dataDir = dataDirFrom(values["data-dir"]);
  const out = resolve(
    positionals[0] ?? `perch-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  try {
    const manifest = await createBackup(
      dataDir,
      out,
      values["include-key"] ? { includeKey: true } : {},
    );
    const key = manifest.masterKey.included
      ? "included (the backup unlocks every credential in it)"
      : `not included (fingerprint ${manifest.masterKey.fingerprint || "-"}); keep ${laptopLayout(dataDir).masterKey} somewhere safe`;
    console.log(
      `backup written to ${out}\n  pglite: ${manifest.pglite ?? "-"}\n  database: ${manifest.database.file} (${manifest.database.rows} rows)\n  files: ${manifest.files.count}\n  master key: ${key}`,
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
  const dataDir = dataDirFrom(values["data-dir"]);
  try {
    const outcome = await restoreBackup(resolve(positionals[0]), dataDir, {
      force: values.force ?? false,
      portable: values.portable ?? false,
    });
    console.log(
      `restored the backup from ${outcome.createdAt} into ${dataDir} (${outcome.from} copy)`,
    );
    if (outcome.keyMatches === false) {
      console.error(
        `warning: ${laptopLayout(dataDir).masterKey} is not the key this backup's credentials were sealed with; they will not decrypt until the original key is put back`,
      );
    } else if (outcome.keyMatches === null && !outcome.keyRestored) {
      console.error(
        `note: this backup does not carry its vault key; put the original master.key in ${dataDir} before perch dev, or credentials will not decrypt`,
      );
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
