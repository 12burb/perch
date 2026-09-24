/**
 * Who a process on a hosted runner runs as (ADR-0171).
 *
 * A hosted runner is one container per workspace, and several people work in it. Before this, the
 * runner agent and everything it started ran as one uid: any child could read the agent's connect
 * token from `/proc/1/environ`, and anyone's shell could read anyone's home, where personal CLI
 * logins live (AGENTS.md §1.6: personal subscription credentials are user-scoped). So, when
 * isolation is on:
 *
 * - The agent runs as root and starts nothing as root. Every child goes through `asUser`, which
 *   prefixes `setpriv` to run it as the member it is for: a uid of their own (allocated from 20000,
 *   stable across restarts through a map in the homes directory), the shared group 1000, no
 *   supplementary groups, no capabilities, no new privileges. A child that is nobody's (a version
 *   probe, the screenshot browser) runs as uid 1000; git holding a credential runs as an account
 *   of its own that nothing else runs as (see `CREDENTIALED_GIT`).
 * - A member's home is theirs: `/data/homes/<user>`, owned by their uid, mode 0700.
 * - Projects are the workspace's: `/data/projects/<workspace>` and every project directory the
 *   runner makes are group 1000, setgid, group-writable, and the runner's umask is 002, so what one
 *   member writes another can change. Repositories are `core.sharedRepository=group`.
 * - What the runner itself reads and writes for a member (fs.*, an agent's file requests, a
 *   project's config) it reads and writes with that member's filesystem credentials (`asUserFs`),
 *   so a root process is never the one following a link a member made.
 *
 * Isolation is on where it can be: Linux, the agent is root, and `PERCH_RUNNER_ISOLATION=users`
 * (the runner image sets it). Everywhere else — a laptop, a local runner, the in-process runner of
 * laptop mode — every function here is the identity: a child runs as the runner does.
 */
import { dlopen, FFIType } from "bun:ffi";
import {
  appendFileSync,
  chmodSync,
  chownSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimpleGitOptions } from "simple-git";
import { z } from "zod";

/** The group every member and every workspace file shares (the image's `perch` group). */
export const PERCH_GID = 1000;
/** Whom a child that is nobody's runs as (the image's `perch` user). */
export const SHARED_UID = 1000;
/** The account credentialed git runs as; nothing else runs as it. */
export const GIT_UID = 19_999;
/** The first uid a member is given, and the last. */
export const FIRST_MEMBER_UID = 20_000;
export const LAST_MEMBER_UID = 59_999;

/**
 * Git holding a credential (a clone or push with a token or a deploy key). It runs as an account
 * of its own rather than the member's: git's environment and the key file are readable by every
 * process of the uid git runs as, and an agent working for the member is one of those
 * (AGENTS.md §1.6: no connection token reaches an engine).
 */
export const CREDENTIALED_GIT = "@git";

/** A member (their Perch user id), nobody in particular (null), or credentialed git. */
export type RunAs = string | null;

export type Account = { uid: number; gid: number; home: string; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uidMapSchema = z
  .object({
    version: z.literal(1),
    users: z.record(
      z.string().regex(UUID),
      z.number().int().min(FIRST_MEMBER_UID).max(LAST_MEMBER_UID),
    ),
  })
  .strict();
type UidMap = z.infer<typeof uidMapSchema>;

/** The map of Perch user ids to uids, beside the homes it describes. */
export const UID_MAP_FILE = ".perch-uids.json";

export type IsolationOptions = {
  /** Where members' homes are (/data/homes); the uid map lives here too. */
  homesRoot: string;
  /** The passwd file entries are appended to (default /etc/passwd). */
  passwd?: string;
  /** setpriv (default: found on PATH). */
  setpriv?: string;
  /** The wrapper simple-git runs git through (default: perch-as on PATH, deploy/perch-as). */
  wrapper?: string;
  /** Home of the shared uid (default /home/perch). */
  sharedHome?: string;
  /** Home of the credentialed-git account (default /home/perch-git). */
  gitHome?: string;
};

type Libc = {
  setfsuid: (uid: number) => number;
  setfsgid: (gid: number) => number;
  prctl: (option: number, a: bigint, b: bigint, c: bigint, d: bigint) => number;
  chmod: (path: string, mode: number) => number;
};

let libcHandle: Libc | null | undefined;
/** glibc, through bun:ffi, on Linux; null anywhere it is not there. */
function libc(): Libc | null {
  if (libcHandle !== undefined) return libcHandle;
  libcHandle = null;
  if (process.platform !== "linux") return null;
  try {
    const lib = dlopen("libc.so.6", {
      setfsuid: { args: [FFIType.u32], returns: FFIType.i32 },
      setfsgid: { args: [FFIType.u32], returns: FFIType.i32 },
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
      chmod: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    libcHandle = {
      setfsuid: (uid) => Number(lib.symbols.setfsuid(uid)),
      setfsgid: (gid) => Number(lib.symbols.setfsgid(gid)),
      prctl: (option, a, b, c, d) => Number(lib.symbols.prctl(option, a, b, c, d)),
      chmod: (path, mode) => Number(lib.symbols.chmod(Buffer.from(`${path}\0`), mode)),
    };
  } catch {
    libcHandle = null;
  }
  return libcHandle;
}

const PR_SET_DUMPABLE = 4;
const PR_GET_DUMPABLE = 3;

/**
 * Makes this process non-dumpable (`prctl(PR_SET_DUMPABLE, 0)`): its `/proc/<pid>/environ`, `mem`
 * and the rest become root's, so a child running as the same uid cannot read the connect token out
 * of them. For a runner that is not isolated (a local runner, or a hosted one without root), where
 * its children do share its uid. Best effort: false where it cannot be done. Never for the
 * in-process runner of laptop mode, which is the api's process.
 */
export function makeUndumpable(): boolean {
  const lib = libc();
  if (!lib) return false;
  try {
    return lib.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) === 0 && dumpable() === false;
  } catch {
    return false;
  }
}

/** Whether this process is dumpable; null where that cannot be asked. */
export function dumpable(): boolean | null {
  const lib = libc();
  if (!lib) return null;
  try {
    return lib.prctl(PR_GET_DUMPABLE, 0n, 0n, 0n, 0n) === 1;
  } catch {
    return null;
  }
}

/** Where the runner can isolate members: Linux, root, and asked to (the runner image asks). */
export function isolationWanted(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  uid: number | undefined = process.getuid?.(),
): boolean {
  return platform === "linux" && uid === 0 && env.PERCH_RUNNER_ISOLATION === "users";
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * A directory's mode, setgid and sticky bits included. Bun's chmod (every form of it) drops those
 * two, so this is libc's; checked, because a workspace directory without them is not one.
 */
export function setDirMode(path: string, mode: number): void {
  const lib = libc();
  if (lib?.chmod(path, mode) !== 0 || (statSync(path).mode & 0o7777) !== mode) {
    throw new Error(`could not set mode ${mode.toString(8)} on ${path}`);
  }
}

/** Owner and group of a tree, links changed and never followed. */
function chownTree(path: string, uid: number, gid: number): void {
  const stats = lstatSync(path);
  lchownSync(path, uid, gid);
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(path)) chownTree(join(path, entry), uid, gid);
}

function whichOr(command: string, fallback: string): string {
  return Bun.which(command) ?? fallback;
}

/** The wrapper simple-git runs git through: installed on PATH in the image, else this checkout's. */
function defaultWrapper(): string {
  return Bun.which("perch-as") ?? join(import.meta.dir, "..", "..", "..", "deploy", "perch-as");
}

export class Isolation {
  readonly homesRoot: string;
  private readonly passwd: string;
  private readonly setpriv: string;
  readonly wrapper: string;
  private readonly sharedHome: string;
  private readonly gitHome: string;
  private map: UidMap;
  /** Members whose passwd entry and home were checked in this process. */
  private readonly prepared = new Map<string, Account>();
  private gitPrepared = false;

  constructor(options: IsolationOptions) {
    this.homesRoot = options.homesRoot;
    this.passwd = options.passwd ?? "/etc/passwd";
    this.setpriv = options.setpriv ?? whichOr("setpriv", "/usr/bin/setpriv");
    this.wrapper = options.wrapper ?? defaultWrapper();
    this.sharedHome = options.sharedHome ?? "/home/perch";
    this.gitHome = options.gitHome ?? "/home/perch-git";
    mkdirSync(this.homesRoot, { recursive: true });
    this.map = this.readMap();
  }

  private mapPath(): string {
    return join(this.homesRoot, UID_MAP_FILE);
  }

  /** The uid map, or a fresh one; a map that does not parse stops the runner rather than reassign uids. */
  private readMap(): UidMap {
    const path = this.mapPath();
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (codeOf(error) === "ENOENT") return { version: 1, users: {} };
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Error(`${path} is not a uid map this runner can read: ${String(error)}`);
    }
    const parsed = uidMapSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${path} is not a uid map this runner can read: ${parsed.error.message}`);
    }
    const seen = new Set<number>();
    for (const uid of Object.values(parsed.data.users)) {
      if (seen.has(uid)) throw new Error(`${path} gives uid ${uid} to two people`);
      seen.add(uid);
    }
    return parsed.data;
  }

  /** Written beside and renamed over, root's and 0600: a crash never leaves half a map. */
  private writeMap(): void {
    const path = this.mapPath();
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.map, null, 2)}\n`, { mode: 0o600 });
    chownSync(temporary, 0, 0);
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  }

  /** uid → name, from the passwd file. */
  private passwdEntries(): Map<number, string> {
    const out = new Map<number, string>();
    let text = "";
    try {
      text = readFileSync(this.passwd, "utf8");
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
    }
    for (const line of text.split("\n")) {
      const fields = line.split(":");
      const uid = Number(fields[2]);
      if (fields.length >= 7 && Number.isInteger(uid)) out.set(uid, fields[0] ?? "");
    }
    return out;
  }

  /** A passwd entry, so tools that ask who they are (git, ssh, a prompt) get an answer. */
  private ensurePasswd(account: Account, shell: string): void {
    const entries = this.passwdEntries();
    const existing = entries.get(account.uid);
    if (existing === account.name) return;
    if (existing !== undefined) {
      throw new Error(
        `uid ${account.uid} is already ${existing} in ${this.passwd}; the runner will not share it`,
      );
    }
    let text = "";
    try {
      text = readFileSync(this.passwd, "utf8");
    } catch {
      text = "";
    }
    const lead = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
    appendFileSync(
      this.passwd,
      `${lead}${account.name}:x:${account.uid}:${account.gid}::${account.home}:${shell}\n`,
    );
  }

  /** A home of the account's own: owned by it, 0700; one found with another owner is handed over, once. */
  private ensureHome(account: Account): void {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(account.home);
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
      mkdirSync(account.home, { recursive: true, mode: 0o700 });
      chownSync(account.home, account.uid, account.gid);
      chmodSync(account.home, 0o700);
      return;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${account.home} is not a directory; no home is made through it`);
    }
    if (stats.uid !== account.uid) chownTree(account.home, account.uid, account.gid);
    if ((stats.mode & 0o7777) !== 0o700) chmodSync(account.home, 0o700);
  }

  /** The uid a member runs as: given on first sight, the same for ever after. */
  uidOf(userId: string): number {
    if (!UUID.test(userId)) throw new Error(`not a user id: ${JSON.stringify(userId)}`);
    const known = this.map.users[userId];
    if (known !== undefined) return known;
    const taken = new Set<number>([
      ...Object.values(this.map.users),
      ...this.passwdEntries().keys(),
    ]);
    let uid = FIRST_MEMBER_UID;
    while (taken.has(uid)) uid++;
    if (uid > LAST_MEMBER_UID) throw new Error("this runner has no uid left to give");
    this.map = { ...this.map, users: { ...this.map.users, [userId]: uid } };
    this.writeMap();
    return uid;
  }

  /** Everyone the map knows, for the runner's start. */
  knownMembers(): string[] {
    return Object.keys(this.map.users);
  }

  /** A member's account: uid, passwd entry and home, checked once per process. */
  member(userId: string): Account {
    const ready = this.prepared.get(userId);
    if (ready) return ready;
    const uid = this.uidOf(userId);
    const account: Account = {
      uid,
      gid: PERCH_GID,
      home: join(this.homesRoot, userId),
      name: `perch-u${uid}`,
    };
    this.ensurePasswd(account, "/bin/bash");
    this.ensureHome(account);
    this.prepared.set(userId, account);
    return account;
  }

  /** Whom `who` runs as. */
  account(who: RunAs): Account {
    if (who === null) {
      return { uid: SHARED_UID, gid: PERCH_GID, home: this.sharedHome, name: "perch" };
    }
    if (who === CREDENTIALED_GIT) {
      const account: Account = {
        uid: GIT_UID,
        gid: PERCH_GID,
        home: this.gitHome,
        name: "perch-git",
      };
      if (!this.gitPrepared) {
        this.ensurePasswd(account, "/usr/sbin/nologin");
        this.ensureHome(account);
        this.gitPrepared = true;
      }
      return account;
    }
    return this.member(who);
  }

  /** setpriv's arguments for an account: its uid, the shared group, nothing else. */
  private dropTo(account: Account): string[] {
    return [
      this.setpriv,
      `--reuid=${account.uid}`,
      `--regid=${account.gid}`,
      "--clear-groups",
      "--inh-caps=-all",
      "--bounding-set=-all",
      "--no-new-privs",
      "--",
    ];
  }

  /** The command line and environment for a child that runs as `who`. */
  launch(
    who: RunAs,
    argv: readonly string[],
    env: Record<string, string>,
  ): { argv: string[]; env: Record<string, string> } {
    const account = this.account(who);
    return {
      argv: [...this.dropTo(account), ...argv],
      env: { ...env, HOME: account.home, USER: account.name, LOGNAME: account.name },
    };
  }

  /**
   * How simple-git starts git as `who`: through the wrapper, which reads the uid from its env, and
   * with every checkout counted safe — a workspace's repository is its members' together, and git
   * otherwise refuses one another member made (`safe.directory` is honoured only from protected
   * config; the image's /etc/gitconfig says the same for shells).
   */
  git(
    who: RunAs,
    env: Record<string, string>,
  ): { binary: [string, string]; config: string[]; env: Record<string, string> } {
    const account = this.account(who);
    return {
      binary: [this.wrapper, "git"],
      config: ["safe.directory=*"],
      env: {
        ...env,
        HOME: account.home,
        USER: account.name,
        LOGNAME: account.name,
        PERCH_AS_UID: String(account.uid),
      },
    };
  }

  /**
   * Runs `fn` with `who`'s filesystem credentials (setfsuid/setfsgid on this thread): the kernel
   * checks every path it opens as that account would be checked, links included. `fn` must be
   * synchronous — the credentials are this thread's for exactly as long as it runs.
   */
  fsAs<T>(who: RunAs, fn: () => T): T {
    const lib = libc();
    if (!lib) throw new Error("isolation needs setfsuid, and this runner has no libc to call");
    const account = this.account(who);
    const previousGid = lib.setfsgid(account.gid);
    const previousUid = lib.setfsuid(account.uid);
    try {
      // setfsuid answers with the previous value whether or not it changed anything: ask again.
      if (lib.setfsuid(0xffff_ffff) !== account.uid || lib.setfsgid(0xffff_ffff) !== account.gid) {
        throw new Error(`could not take the filesystem credentials of uid ${account.uid}`);
      }
      return fn();
    } finally {
      lib.setfsuid(previousUid);
      lib.setfsgid(previousGid);
    }
  }

  /** A path the runner made that `who` must be able to use (a key file, a scratch index). */
  giveTo(who: RunAs, path: string): void {
    const account = this.account(who);
    chownSync(path, account.uid, account.gid);
  }

  /** `/data/projects/<workspace>`: root's, group 1000, setgid, group-writable, sticky. */
  prepareWorkspaceDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const stats = statSync(dir);
    const migrated = (stats.mode & 0o2000) !== 0;
    if (!migrated) {
      for (const entry of readdirSync(dir)) this.migrateLegacy(join(dir, entry));
    }
    chownSync(dir, 0, PERCH_GID);
    setDirMode(dir, 0o3775);
  }

  /** A project's directory: root's, group 1000, setgid, group-writable. */
  prepareProjectDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
    chownSync(dir, 0, PERCH_GID);
    setDirMode(dir, 0o2775);
  }

  /**
   * A project from before isolation: every file uid 1000's, mode 644/755. Made group-writable and
   * its directories setgid, by uid 1000 (whose files they are), so no root process walks a tree
   * someone else can change under it.
   */
  private migrateLegacy(path: string): void {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(path);
    } catch {
      return;
    }
    if (!stats.isDirectory() || (stats.mode & 0o2000) !== 0) return;
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    for (const argv of [
      ["chmod", "-R", "g+rwX", "--", path],
      ["find", path, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"],
      ...(existsSync(join(path, ".git"))
        ? [["git", "-C", path, "config", "core.sharedRepository", "group"]]
        : []),
    ]) {
      const run = this.launch(null, argv, env);
      Bun.spawnSync(run.argv, { env: run.env, stdout: "ignore", stderr: "ignore" });
    }
  }

  /**
   * Everything a runner does once, before it serves anyone: the umask, the homes directory as
   * root's, every known member's passwd entry and home, the credentialed-git account, and each
   * workspace directory under the projects root. Fails if setpriv cannot drop to an account here.
   */
  start(projectsRoot: string): void {
    process.umask(0o002);
    chownSync(this.homesRoot, 0, 0);
    chmodSync(this.homesRoot, 0o755);
    const check = this.launch(null, ["true"], { PATH: process.env.PATH ?? "/usr/bin:/bin" });
    const probe = Bun.spawnSync(check.argv, { env: check.env, stdout: "ignore", stderr: "pipe" });
    if (probe.exitCode !== 0) {
      throw new Error(
        `setpriv could not drop to uid ${SHARED_UID} (${probe.stderr.toString().trim() || `exit ${probe.exitCode}`}); isolation needs root with CAP_SETUID, CAP_SETGID and CAP_SETPCAP`,
      );
    }
    // Members this runner has seen before get their passwd entry back (a new container has a fresh
    // /etc/passwd). A home nobody has used here yet is left as it is until its member arrives: it
    // was made 0700, so no other member can read it meanwhile.
    for (const userId of this.knownMembers()) this.member(userId);
    this.account(CREDENTIALED_GIT);
    mkdirSync(projectsRoot, { recursive: true });
    chownSync(projectsRoot, 0, 0);
    chmodSync(projectsRoot, 0o755);
    for (const entry of readdirSync(projectsRoot)) {
      if (UUID.test(entry)) this.prepareWorkspaceDir(join(projectsRoot, entry));
    }
  }
}

/** How a runner process protects its own connect token: the answer `protectRunner` gives. */
export type Protection = "isolated" | "undumpable" | "unprotected";

/**
 * What a runner process does about its own token before it serves anyone (ADR-0171). A hosted
 * runner that can isolate members does, and fails rather than run without it once asked; any other
 * Linux runner makes itself non-dumpable, so a child running as its uid cannot read its environment
 * out of /proc; elsewhere it says, once, that it cannot. The in-process runner of laptop mode never
 * calls this: it is the api's own process.
 */
export function protectRunner(options: {
  projectsRoot: string;
  homesRoot: string;
  log: (level: "info" | "warn", message: string, fields?: Record<string, unknown>) => void;
  /** Local runners serve their owner only and never isolate (default true). */
  allowIsolation?: boolean;
  env?: Record<string, string | undefined>;
}): Protection {
  const env = options.env ?? process.env;
  if (options.allowIsolation !== false && isolationWanted(env)) {
    const next = new Isolation({ homesRoot: options.homesRoot });
    next.start(options.projectsRoot);
    useIsolation(next);
    options.log("info", "members run as uids of their own", {
      homes: options.homesRoot,
      members: next.knownMembers().length,
    });
    return "isolated";
  }
  if (env.PERCH_RUNNER_ISOLATION === "users") {
    options.log("warn", "PERCH_RUNNER_ISOLATION=users needs a root runner on Linux; not isolating");
  }
  if (process.platform === "linux" && makeUndumpable()) return "undumpable";
  if (process.platform === "linux") {
    options.log(
      "warn",
      "could not make the runner non-dumpable: a process it starts as its own uid could read its token from /proc",
    );
  }
  return "unprotected";
}

let active: Isolation | null = null;

/** The runner's isolation, or null where children run as the runner does. */
export function isolation(): Isolation | null {
  return active;
}

/** Turns isolation on (the hosted entrypoint) or off (tests put it back). */
export function useIsolation(next: Isolation | null): void {
  active = next;
}

/**
 * Every child the runner starts goes through here: the command line and environment to start it
 * with, as `who`. The identity where isolation is off.
 */
export function asUser(
  who: RunAs,
  argv: readonly string[],
  env: Record<string, string>,
): { argv: string[]; env: Record<string, string> } {
  return active ? active.launch(who, argv, env) : { argv: [...argv], env };
}

/** simple-git's options and environment for git as `who` (the wrapper where isolation is on). */
export function asUserGit(
  who: RunAs,
  env: Record<string, string>,
): { options: Partial<SimpleGitOptions>; env: Record<string, string> } {
  if (!active) return { options: {}, env };
  const git = active.git(who, env);
  return { options: { binary: git.binary, config: git.config }, env: git.env };
}

/** `fn`, with `who`'s filesystem credentials where isolation is on; synchronous only. */
export function asUserFs<T>(who: RunAs, fn: () => T): T {
  return active ? active.fsAs(who, fn) : fn();
}

/**
 * A private scratch directory `who` can use (an index, a key file, a patch), with `files` written
 * into it before it is handed over — so nothing of `who`'s is ever in it while root writes there.
 */
export function userTempDir(
  who: RunAs,
  prefix: string,
  files: Record<string, { content: string; mode: number }> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [name, file] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, file.content, { mode: file.mode, flag: "wx" });
    chmodSync(path, file.mode);
    active?.giveTo(who, path);
  }
  active?.giveTo(who, dir);
  return dir;
}

/** A workspace's directory under the projects root, made (and made shared) before use. */
export function prepareWorkspaceDir(dir: string): void {
  if (active) active.prepareWorkspaceDir(dir);
  else mkdirSync(dir, { recursive: true });
}

/** A project's directory, made (and made shared) before anything is put in it. */
export function prepareProjectDir(dir: string): void {
  if (active) active.prepareProjectDir(dir);
  else mkdirSync(dir, { recursive: true });
}
