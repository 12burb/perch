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
 *
 * `perch backup` writes this same format, with the PGlite data directory as one more file beside
 * the dump, so either kind of instance restores the other's backups (ADR-0175).
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
import { createGunzip } from "node:zlib";
import {
  createDb,
  type DbHandle,
  databaseIsEmpty,
  dumpGzipped,
  linesOf,
  type RestoreResult,
  restoreDatabase,
} from "@perch/db";
import type { Logger } from "pino";
import { z } from "zod";
import { loadEnv } from "../env.ts";
import { PerchError } from "../errors.ts";
import { createLogger } from "../logging.ts";

export const BACKUPS_QUEUE = "backups";
/** The schedule's identity in the jobs table; scheduling it again moves it rather than adding one. */
export const NIGHTLY_KEY = "backup:nightly";

export const BACKUP_FORMAT = "perch-instance-backup";
export const BACKUP_VERSION = 1;
/** The dump's name inside a backup directory, whichever writer made it. */
export const DUMP_FILE = "database.jsonl.gz";

/**
 * A name inside the backup directory: no separators, no `..`, nothing hidden. A manifest is read
 * from wherever a backup came from, and a restore copies what it names; a name that climbed out of
 * the directory would copy some other directory into the files store (ADR-0175).
 */
const inside = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const count = z.number().int().nonnegative();

const manifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  createdAt: z.string(),
  perchVersion: z.string(),
  mode: z.enum(["laptop", "team"]),
  driver: z.enum(["postgres", "pglite"]),
  /** `migrations` is the schema the rows were read at (absent on backups from before it was kept). */
  database: z.object({
    file: inside,
    tables: count,
    rows: count,
    bytes: count,
    migrations: count.optional(),
  }),
  files: z.object({ dir: inside, count, bytes: count }),
  /**
   * The vault key. `included` writes it into the backup, which makes the backup as sensitive as
   * the instance; the fingerprint is always there, so a restore can tell whether the key it has is
   * the key these rows were encrypted with. Empty when the backup does not say.
   */
  masterKey: z.object({ included: z.boolean(), fingerprint: z.string() }),
  /** Written by the supervisor when it has taken the project volumes (see `projects.json`). */
  projects: z.object({ file: inside, bytes: count, projects: count }).nullable().optional(),
  /** Laptop backups: PGlite's own data directory as a tarball, the exact copy `perch restore` prefers. */
  pglite: inside.optional(),
});

export type BackupManifest = z.infer<typeof manifestSchema>;

/** What `perch backup` wrote before it wrote the format above (versions 1 and 2). */
const laptopManifestSchema = z.object({
  format: z.literal("perch-backup"),
  version: z.union([z.literal(1), z.literal(2)]),
  createdAt: z.string(),
  pglite: inside,
  database: z.object({ file: inside, tables: count, rows: count }).optional(),
  files: z.boolean(),
  masterKey: z.boolean(),
});

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

/** How many files, and how many bytes, are at `path` (a file or a directory tree). */
export function sizeOf(path: string): { count: number; bytes: number } {
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

/** What an older `perch backup` wrote, read as the one format; null when it is not one. */
function fromLaptopManifest(dir: string, raw: unknown): BackupManifest | null {
  const parsed = laptopManifestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const old = parsed.data;
  if (!old.database) {
    throw new Error(
      `${dir} was taken before backups carried a portable dump; only \`perch restore\` can load it`,
    );
  }
  const keyPath = join(dir, "master.key");
  const included = old.masterKey && existsSync(keyPath);
  const files = old.files ? sizeOf(join(dir, "files")) : { count: 0, bytes: 0 };
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: old.createdAt,
    perchVersion: "unknown",
    mode: "laptop",
    driver: "pglite",
    database: { ...old.database, bytes: sizeOf(join(dir, old.database.file)).bytes },
    files: { dir: "files", ...files },
    // Those backups carried the key itself or nothing: its fingerprint, or no claim at all.
    masterKey: {
      included,
      fingerprint: included ? fingerprintKey(readFileSync(keyPath, "utf8").trim()) : "",
    },
    projects: null,
    pglite: old.pglite,
  };
}

export function readManifest(dir: string): BackupManifest {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) throw new Error(`${dir} is not a Perch backup (no manifest.json)`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${dir} is not a Perch backup (manifest.json is not JSON)`);
  }
  const laptop = fromLaptopManifest(dir, raw);
  if (laptop) return laptop;
  const version = (raw as { format?: unknown; version?: unknown } | null)?.version;
  if (
    (raw as { format?: unknown } | null)?.format === BACKUP_FORMAT &&
    version !== BACKUP_VERSION
  ) {
    throw new Error(`this Perch reads backup version ${BACKUP_VERSION}, not ${String(version)}`);
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${dir} is not a Perch backup`);
  return parsed.data;
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
    // Everything in here is as sensitive as the instance: only its owner reads it.
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    let summary: BackupSummary;
    try {
      const counts = await dumpGzipped(
        this.deps.db.db,
        createWriteStream(join(dir, DUMP_FILE), { mode: 0o600 }),
      );

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
          file: DUMP_FILE,
          tables: counts.tables,
          rows: counts.rows,
          bytes: sizeOf(join(dir, DUMP_FILE)).bytes,
          migrations: counts.migrations,
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
      summary = {
        id,
        path: dir,
        createdAt: manifest.createdAt,
        bytes: sizeOf(dir).bytes,
        manifest,
      };
    } catch (error) {
      // A half-written backup is worse than none: it would be the one restored from.
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    // Outside the try: the backup above is complete, and an older one that will not go away is
    // no reason to delete it (ADR-0175).
    try {
      this.prune(options.keep ?? this.deps.env.backup.keep, root);
    } catch (error) {
      this.deps.log.warn({ err: error, backup: id }, "could not remove an older backup");
    }
    return summary;
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
   * because a restore on top of live rows is a merge nobody asked for. A backup from an older
   * Perch needs a database no migration has run on (see `restoreDatabase`), which is what the
   * `restore` entrypoint gives it by running before boot.
   *
   * The key is checked, not replaced: a running instance already booted with one, and quietly
   * decrypting nothing would look like an empty vault rather than the wrong key. `keyMatches` is
   * null when the backup does not say which key it was taken with.
   */
  async restore(
    dir: string,
    options: { force?: boolean } = {},
  ): Promise<RestoreResult & { files: number; keyMatches: boolean | null }> {
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
    const counts = await restoreDatabase(this.deps.db, linesOf(stream));

    let files = 0;
    const from = join(dir, manifest.files.dir);
    if (existsSync(from)) {
      await cp(from, this.deps.env.filesDir, { recursive: true, force: true });
      files = sizeOf(this.deps.env.filesDir).count;
    }
    const keyMatches = manifest.masterKey.fingerprint
      ? manifest.masterKey.fingerprint === fingerprintKey(this.deps.env.masterKey)
      : null;
    if (keyMatches === false) {
      this.deps.log.warn(
        { backup: manifest.createdAt },
        "restored rows were encrypted with a different master key; credentials will not decrypt",
      );
    }
    this.deps.log.info(
      { rows: counts.rows, files, keyMatches, schema: counts.schema },
      "restored a backup",
    );
    return { ...counts, files, keyMatches };
  }
}

/**
 * `bun apps/api/src/index.ts restore <dir> [--force]`: runs before boot, so a database nothing has
 * migrated stays that way until the backup says which schema its rows were written at; they load
 * at that schema and migrate forward, as they would have in an upgrade (ADR-0175). Returns the
 * process's exit code.
 */
export async function restoreEntrypoint(argv: string[]): Promise<number> {
  const dir = argv.find((one) => !one.startsWith("--"));
  if (!dir) {
    console.error("usage: restore <backup-dir> [--force]");
    return 2;
  }
  const env = loadEnv();
  const log = createLogger({ level: env.logLevel, pretty: env.logPretty });
  const db = await createDb({ url: env.databaseUrl });
  try {
    // A restore writes no manifest, so the version it would record is never read.
    const service = new BackupsService({ env, db, log, version: { version: "restore" } });
    const result = await service.restore(dir, { force: argv.includes("--force") });
    console.log(`restored ${result.rows} rows and ${result.files} files from ${dir}`);
    if (result.schema.backup < result.schema.current) {
      console.log(
        `  loaded at schema ${result.schema.backup}, the one it was taken at, and migrated to ${result.schema.current}`,
      );
    }
    if (result.keyMatches === false) {
      console.error(
        "warning: this instance's PERCH_MASTER_KEY is not the one these rows were encrypted with; credentials will not decrypt",
      );
    } else if (result.keyMatches === null) {
      console.error(
        "note: this backup does not record which master key it was taken with; credentials decrypt only with that key",
      );
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await db.close();
  }
}
