/**
 * Backups you can trust (task 4.4; spec §7.1 `/api/admin/backup`, §10's Phase 4 line).
 *
 * A backup is a directory: the database as a gzipped JSON-lines dump (`@perch/db`'s logical
 * format, so a laptop's backup restores into Postgres and back), the files directory beside it,
 * the vault key or its fingerprint, and a manifest that says what is in there. Project volumes are
 * added by the supervisor, which is the process that can see them — the api never mounts them, and
 * never mounts the Docker socket (spec §1.6).
 *
 * The directory is the record. There is no backups table: what exists on disk is what can be
 * restored, and a row claiming otherwise would be a second source of truth about the one thing
 * that has to be true when everything else is gone.
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import {
  type BackupCounts,
  type DbHandle,
  databaseIsEmpty,
  dumpDatabase,
  linesOf,
  restoreDatabase,
} from "@perch/db";
import type { Logger } from "pino";
import { PerchError } from "../errors.ts";

export const BACKUPS_QUEUE = "backups";
/** The schedule's identity in the jobs table; scheduling it again moves it rather than adding one. */
export const NIGHTLY_KEY = "backup:nightly";

export const BACKUP_FORMAT = "perch-instance-backup";
export const BACKUP_VERSION = 1;

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  perchVersion: string;
  mode: "laptop" | "team";
  driver: "postgres" | "pglite";
  database: { file: string; tables: number; rows: number; bytes: number };
  files: { dir: string; count: number; bytes: number };
  /**
   * The vault key. `included` writes it into the backup, which makes the backup as sensitive as
   * the instance; the fingerprint is always there, so a restore can tell whether the key it has is
   * the key these rows were encrypted with.
   */
  masterKey: { included: boolean; fingerprint: string };
  /** Written by the supervisor when it has taken the project volumes (see `projects.json`). */
  projects?: { file: string; bytes: number; projects: number } | null;
};

export type BackupSummary = {
  /** The directory's name, which is also its id: `perch-2026-09-16T03-00-00Z`. */
  id: string;
  path: string;
  createdAt: string;
  bytes: number;
  manifest: BackupManifest;
};

export type BackupsDeps = {
  env: {
    mode: "laptop" | "team";
    filesDir: string;
    masterKey: string;
    backup: { dir: string | undefined; cron: string; keep: number; includeKey: boolean };
  };
  db: DbHandle;
  log: Logger;
  version: { version: string };
  /**
   * Asks whoever can see the project volumes to add them (the supervisor, through the queue). Not
   * set in laptop mode, where the projects are the runner's own directories and go with the files.
   */
  requestVolumes?: (dir: string) => Promise<unknown>;
  now?: () => Date;
};

/** Enough of the key to recognise it, and nothing like enough to use it. */
export function fingerprintKey(masterKey: string): string {
  return new Bun.CryptoHasher("sha256").update(`perch-key:${masterKey}`).digest("hex").slice(0, 16);
}

/** `perch-2026-09-16T03-00-00Z`: sortable, and a legal directory name on every platform. */
export function backupId(at: Date): string {
  return `perch-${at
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/:/g, "-")}`;
}

function sizeOf(path: string): { count: number; bytes: number } {
  if (!existsSync(path)) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        count += 1;
        bytes += statSync(full).size;
      }
    }
  };
  const stat = statSync(path);
  if (stat.isFile()) return { count: 1, bytes: stat.size };
  walk(path);
  return { count, bytes };
}

export function readManifest(dir: string): BackupManifest {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) throw new Error(`${dir} is not a Perch backup (no manifest.json)`);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Partial<BackupManifest>;
  if (manifest.format !== BACKUP_FORMAT) throw new Error(`${dir} is not a Perch backup`);
  if (manifest.version !== BACKUP_VERSION) {
    throw new Error(`this Perch reads backup version ${BACKUP_VERSION}, not ${manifest.version}`);
  }
  return manifest as BackupManifest;
}

export class BackupsService {
  constructor(private readonly deps: BackupsDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Where backups go, or nothing when this instance takes none on its own. */
  get root(): string | undefined {
    return this.deps.env.backup.dir;
  }

  private rootOr(dir?: string): string {
    const root = dir ?? this.root;
    if (!root) {
      throw new PerchError(
        "conflict",
        "this instance takes no backups: set PERCH_BACKUP_DIR to a directory it can write to",
        {},
        409,
      );
    }
    return root;
  }

  /**
   * Takes a backup now. The database goes first and in one transaction, so the dump is one moment
   * rather than a smear; the files are copied after it, which is the right order — a file row that
   * points at a file that has not been copied yet is a broken thumbnail, while a file with no row
   * is nothing at all.
   */
  async create(options: { dir?: string; keep?: number } = {}): Promise<BackupSummary> {
    const root = this.rootOr(options.dir);
    const at = this.now();
    const id = backupId(at);
    const dir = join(root, id);
    if (existsSync(dir)) throw new Error(`${dir} already exists`);
    mkdirSync(dir, { recursive: true });

    let counts: BackupCounts = { tables: 0, rows: 0 };
    try {
      const gzip = createGzip();
      const out = createWriteStream(join(dir, "database.jsonl.gz"));
      const done = pipeline(gzip, out);
      counts = await dumpDatabase(this.deps.db.db, async (line) => {
        if (!gzip.write(line)) await new Promise<void>((r) => gzip.once("drain", () => r()));
      });
      gzip.end();
      await done;

      const files = sizeOf(this.deps.env.filesDir);
      if (files.count > 0) {
        await cp(this.deps.env.filesDir, join(dir, "files"), { recursive: true });
      }

      const fingerprint = fingerprintKey(this.deps.env.masterKey);
      if (this.deps.env.backup.includeKey) {
        writeFileSync(join(dir, "master.key"), `${this.deps.env.masterKey}\n`, { mode: 0o600 });
      }

      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: at.toISOString(),
        perchVersion: this.deps.version.version,
        mode: this.deps.env.mode,
        driver: this.deps.db.driver,
        database: {
          file: "database.jsonl.gz",
          tables: counts.tables,
          rows: counts.rows,
          bytes: sizeOf(join(dir, "database.jsonl.gz")).bytes,
        },
        files: { dir: "files", count: files.count, bytes: files.bytes },
        masterKey: { included: this.deps.env.backup.includeKey, fingerprint },
        projects: null,
      };
      writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      // The project volumes are the supervisor's to add, and it writes its own line in the
      // manifest when it has: a backup is complete when that line is there.
      await this.deps.requestVolumes?.(dir);
      this.deps.log.info({ backup: id, rows: counts.rows, files: files.count }, "took a backup");
      this.prune(options.keep ?? this.deps.env.backup.keep, root);
      return { id, path: dir, createdAt: manifest.createdAt, bytes: sizeOf(dir).bytes, manifest };
    } catch (error) {
      // A half-written backup is worse than none: it would be the one restored from.
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** What is on disk, newest first. A directory without a readable manifest is not a backup. */
  list(dir?: string): BackupSummary[] {
    const root = dir ?? this.root;
    if (!root || !existsSync(root)) return [];
    const found: BackupSummary[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      try {
        const manifest = readManifest(path);
        found.push({
          id: entry.name,
          path,
          createdAt: manifest.createdAt,
          bytes: sizeOf(path).bytes,
          manifest,
        });
      } catch {
        this.deps.log.warn({ path }, "a directory beside the backups is not one");
      }
    }
    return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Keeps the newest `keep` and removes the rest; returns what went. */
  prune(keep: number, dir?: string): string[] {
    const removed: string[] = [];
    for (const backup of this.list(dir).slice(Math.max(1, keep))) {
      rmSync(backup.path, { recursive: true, force: true });
      removed.push(backup.id);
    }
    if (removed.length > 0) this.deps.log.info({ removed }, "pruned older backups");
    return removed;
  }

  /**
   * Loads a backup into this instance. The database must be empty unless `force` says otherwise,
   * because a restore on top of live rows is a merge nobody asked for.
   *
   * The key is checked, not replaced: a running instance already booted with one, and quietly
   * decrypting nothing would look like an empty vault rather than the wrong key.
   */
  async restore(
    dir: string,
    options: { force?: boolean } = {},
  ): Promise<BackupCounts & { files: number; keyMatches: boolean }> {
    const manifest = readManifest(dir);
    if (!options.force && !(await databaseIsEmpty(this.deps.db.db))) {
      throw new PerchError(
        "conflict",
        "this instance already has data; restore into an empty one, or pass force",
        {},
        409,
      );
    }
    const dump = join(dir, manifest.database.file);
    if (!existsSync(dump)) throw new Error(`${dir} has no ${manifest.database.file}`);
    const stream = Readable.toWeb(
      createReadStream(dump).pipe(createGunzip()),
    ) as ReadableStream<Uint8Array>;
    const counts = await restoreDatabase(this.deps.db.db, linesOf(stream));

    let files = 0;
    const from = join(dir, manifest.files.dir);
    if (existsSync(from)) {
      await cp(from, this.deps.env.filesDir, { recursive: true, force: true });
      files = sizeOf(this.deps.env.filesDir).count;
    }
    const keyMatches = manifest.masterKey.fingerprint === fingerprintKey(this.deps.env.masterKey);
    if (!keyMatches) {
      this.deps.log.warn(
        { backup: manifest.createdAt },
        "restored rows were encrypted with a different master key; credentials will not decrypt",
      );
    }
    this.deps.log.info({ rows: counts.rows, files, keyMatches }, "restored a backup");
    return { ...counts, files, keyMatches };
  }
}
