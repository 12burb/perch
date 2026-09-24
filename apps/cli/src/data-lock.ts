/**
 * One Perch per data directory (ADR-0175).
 *
 * PGlite does not refuse a second opener: two processes on the same files both succeed, and
 * whichever closes last writes its view over the other's committed work. So everything in laptop
 * mode that opens `<dataDir>/data` — `perch dev`, `perch demo`, the desktop app, `perch doctor`'s
 * database check, `perch backup` and `perch restore` — first creates `<dataDir>/perch.lock` with
 * O_EXCL and keeps it for as long as it has the database open.
 *
 * The file says who holds it (pid, when it started, what it is, and the URL once it serves one).
 * It is a leftover, and taken over, only when that pid is no longer running — or when it is this
 * process's own pid and this process never took it, which is how a container that always starts
 * as pid 1 finds the lock its crashed predecessor left.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export type LockHolder = { pid: number; startedAt: string; command: string; url?: string };

/** The lock file's contents, checked field by field; anything else is not a holder. */
function asHolder(value: unknown): LockHolder | null {
  if (!value || typeof value !== "object") return null;
  const { pid, startedAt, command, url } = value as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "string" || typeof command !== "string") return null;
  if (url !== undefined && typeof url !== "string") return null;
  return { pid, startedAt, command, ...(url === undefined ? {} : { url }) };
}

export class DataDirInUse extends Error {
  constructor(
    readonly dataDir: string,
    readonly holder: LockHolder,
  ) {
    super(
      `${dataDir} is in use by another Perch (${holder.command}, pid ${holder.pid}${holder.url ? `, at ${holder.url}` : ""}); stop it first, or pass --data-dir`,
    );
    this.name = "DataDirInUse";
  }
}

export type DataDirLock = {
  readonly path: string;
  /** Adds what the holder is serving, for the message a second opener sees. */
  describe(extra: { url: string }): void;
  /** Removes the lock; idempotent. */
  release(): void;
};

/** The lock files this process holds, so a leftover with this pid is not mistaken for one. */
const held = new Set<string>();

export function lockFile(dataDir: string): string {
  return join(dataDir, "perch.lock");
}

function readHolder(path: string): LockHolder | null {
  try {
    return asHolder(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** Whether a process with this pid exists (EPERM: it does, and belongs to someone else). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The live holder of a data directory's lock, or null when nothing holds it. */
export function lockHolder(dataDir: string): LockHolder | null {
  const path = lockFile(dataDir);
  const holder = readHolder(path);
  if (!holder) return null;
  if (holder.pid === process.pid) return held.has(path) ? holder : null;
  return running(holder.pid) ? holder : null;
}

/**
 * Takes the data directory for this process, or throws `DataDirInUse` naming who has it. `command`
 * is what a second opener is told is holding it ("perch dev", "perch backup").
 */
export function lockDataDir(dataDir: string, command: string): DataDirLock {
  mkdirSync(dataDir, { recursive: true });
  const path = lockFile(dataDir);
  const holder: LockHolder = { pid: process.pid, startedAt: new Date().toISOString(), command };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(holder));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
      const current = lockHolder(dataDir);
      if (current) throw new DataDirInUse(dataDir, current);
      // A leftover from a process that is gone: removed, and the exclusive create tried once more
      // (a second process doing the same at the same moment loses that create and is refused).
      rmSync(path, { force: true });
    }
  }
  held.add(path);
  // A process that exits without stopping (process.exit on an error path) still lets go.
  const onExit = () => release();
  process.once("exit", onExit);
  let released = false;
  function release(): void {
    if (released) return;
    released = true;
    held.delete(path);
    process.removeListener("exit", onExit);
    // Only our own lock: never one a later process has taken since.
    if (readHolder(path)?.pid === process.pid) rmSync(path, { force: true });
  }
  return {
    path,
    describe(extra) {
      if (released) return;
      Object.assign(holder, extra);
      writeFileSync(path, JSON.stringify(holder), { mode: 0o600 });
    },
    release,
  };
}
