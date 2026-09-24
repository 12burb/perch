/**
 * Git holding a credential (ADR-0171): a clone or push with a connection token or the workspace's
 * deploy key. Three things used to let the credential go somewhere it should not:
 *
 * - Repository hooks ran with the token in git's environment (`core.hooksPath` can point anywhere
 *   in the tree, so a hook is a file any member can write).
 * - Perch's credential helper answered any host, and helpers configured in the repository ran
 *   beside it — a `store` helper is handed the token after a successful push.
 * - The push went wherever `origin` pointed after `url.*.insteadOf` rewrites, so a changed remote
 *   sent the token to someone else's host.
 *
 * So a credentialed git run carries its own configuration on the command line, which git reads
 * last: hooks off, every configured helper dropped, Perch's helper answering for the remote's own
 * scheme and host only, TLS verification on, and no transport but the one the remote uses. Before a
 * push, the effective push URL (`git remote get-url --push`, rewrites applied) must be https (plain
 * http only on this machine) or ssh, on the host the project was cloned from; a repository whose
 * own config reroutes or re-trusts the transport (a proxy, a CA, `sslVerify`) is refused.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JSON_RPC_ERRORS, RunnerRpcError } from "@perch/events";
import { z } from "zod";
import { isolation } from "./identity.ts";

export type RemoteOrigin = {
  scheme: "https" | "http" | "ssh";
  /** Lowercased, with a port only where it is not the scheme's default. */
  host: string;
};

export type GitCredential =
  | { kind: "token"; username?: string | undefined; token: string }
  | { kind: "ssh"; privateKey: string };

const DEFAULT_PORT: Record<RemoteOrigin["scheme"], string> = {
  https: "443",
  http: "80",
  ssh: "22",
};

function normalizeHost(scheme: RemoteOrigin["scheme"], hostname: string, port: string): string {
  const name = hostname.toLowerCase();
  return port && port !== DEFAULT_PORT[scheme] ? `${name}:${port}` : name;
}

/**
 * Where a git URL goes: `https://…`, `http://…`, `ssh://…`, or scp's `[user@]host:path`. Anything
 * else — a local path, `file://`, `ext::…`, a remote helper — is null: nothing to give a
 * credential to.
 */
export function remoteOrigin(url: string): RemoteOrigin | null {
  const text = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      return null;
    }
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    if (scheme !== "https" && scheme !== "http" && scheme !== "ssh") return null;
    if (!parsed.hostname) return null;
    return { scheme, host: normalizeHost(scheme, parsed.hostname, parsed.port) };
  }
  // scp-like: no scheme, a host before the first colon, and not `C:\…` or `::` (a remote helper).
  const scp = /^(?:[^@/:\s]+@)?([^@/:\s]+):(?!:)/.exec(text);
  if (scp?.[1] && scp[1].length > 1) return { scheme: "ssh", host: scp[1].toLowerCase() };
  return null;
}

export function originText(origin: RemoteOrigin): string {
  return `${origin.scheme}://${origin.host}`;
}

function hostnameOf(origin: RemoteOrigin): string {
  return origin.host.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").replace(/:\d+$/, "");
}

/** This machine: where a test's git server or a laptop's own forge runs. */
export function isLoopback(origin: RemoteOrigin): boolean {
  const name = hostnameOf(origin);
  return name === "localhost" || name === "::1" || /^127\.\d+\.\d+\.\d+$/.test(name);
}

/**
 * The transport a credential may travel over: a token over https (plain http only to this
 * machine), a deploy key over ssh.
 */
export function assertCredentialTransport(
  auth: GitCredential,
  origin: RemoteOrigin | null,
): RemoteOrigin {
  if (!origin) {
    throw new RunnerRpcError(
      JSON_RPC_ERRORS.invalidParams,
      "a credential goes only to an https or ssh remote, and this one is neither",
    );
  }
  if (auth.kind === "token") {
    if (origin.scheme === "https" || (origin.scheme === "http" && isLoopback(origin)))
      return origin;
    throw new RunnerRpcError(
      JSON_RPC_ERRORS.invalidParams,
      `a token goes only over https, not to ${originText(origin)}`,
    );
  }
  if (origin.scheme === "ssh") return origin;
  throw new RunnerRpcError(
    JSON_RPC_ERRORS.invalidParams,
    `a deploy key goes only over ssh, not to ${originText(origin)}`,
  );
}

/**
 * The effective push URL, checked before a credentialed push: the right transport, on the host the
 * project was cloned from (the hostname; a clone over https pushed with the deploy key over ssh is
 * the same host).
 */
export function assertPushRemote(
  auth: GitCredential,
  pushUrl: string,
  expected: RemoteOrigin | null,
): RemoteOrigin {
  const origin = assertCredentialTransport(auth, remoteOrigin(pushUrl));
  if (expected) {
    const same =
      expected.scheme === origin.scheme
        ? expected.host === origin.host
        : hostnameOf(expected) === hostnameOf(origin);
    if (!same) {
      throw new RunnerRpcError(
        JSON_RPC_ERRORS.invalidParams,
        `origin now points at ${originText(origin)}, not ${originText(expected)} where this project came from; a credential is not sent there`,
      );
    }
  }
  return origin;
}

/**
 * What git needs for a credentialed run: configuration (on the command line, read after every
 * file) and environment — never the credential on argv.
 */
export function gitAuth(
  auth: GitCredential | undefined,
  keyFile?: string,
  origin?: RemoteOrigin,
): { config: string[]; env: Record<string, string> } {
  if (!auth) return { config: [], env: {} };
  const base = [
    // No hook runs while git holds a credential: `core.hooksPath` could point into the tree.
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    // Every helper the repository or anyone else configured is dropped before Perch's is added.
    "credential.helper=",
    "http.sslVerify=true",
    // No transport but the remote's own: an insteadOf rewrite to `ext::` or `file://` goes nowhere.
    "protocol.allow=never",
    "protocol.ext.allow=never",
    "protocol.file.allow=never",
  ];
  if (auth.kind === "token") {
    if (!origin) throw new Error("a token needs the remote it is for");
    return {
      config: [
        ...base,
        `protocol.${origin.scheme}.allow=always`,
        // Perch's helper answers for this scheme and host only.
        `credential.${originText(origin)}.helper=!f() { echo "username=$PERCH_GIT_USERNAME"; echo "password=$PERCH_GIT_SECRET"; }; f`,
      ],
      env: {
        PERCH_GIT_USERNAME: auth.username ?? "x-access-token",
        PERCH_GIT_SECRET: auth.token,
        GIT_TERMINAL_PROMPT: "0",
      },
    };
  }
  if (!keyFile) throw new Error("ssh auth needs a key file");
  return {
    config: [...base, "protocol.ssh.allow=always"],
    env: {
      GIT_SSH_COMMAND: `ssh -i ${JSON.stringify(keyFile)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
      GIT_TERMINAL_PROMPT: "0",
    },
  };
}

/**
 * Settings that reroute or re-trust the transport, from `git config --show-scope --list`, in a
 * scope a member can write (the repository's own, a worktree's, or — when the caller says so — the
 * global file): a proxy, a CA, TLS verification, a pinned address. A URL-specific setting in the
 * repository beats anything generic given on the command line, so these are refused, not
 * overridden.
 */
export function riskyTransportConfig(
  listing: string,
  scopes: readonly string[] = ["local", "worktree"],
): string[] {
  const risky =
    /^(?:http\.(?:.*\.)?(?:proxy|proxyauthmethod|proxysslcainfo|proxysslcert|proxysslkey|sslcainfo|sslcapath|sslverify|sslbackend|sslcert|sslkey|curloptresolve)|remote\..+\.proxy)$/i;
  const out: string[] = [];
  for (const line of listing.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const scope = line.slice(0, tab);
    const entry = line.slice(tab + 1);
    const key = entry.slice(0, entry.includes("=") ? entry.indexOf("=") : entry.length);
    if (scopes.includes(scope) && risky.test(key)) out.push(`${scope} ${key}`);
  }
  return out;
}

const recordsSchema = z
  .object({
    version: z.literal(1),
    remotes: z.record(
      z.string(),
      z.object({ scheme: z.enum(["https", "http", "ssh"]), host: z.string().min(1) }).strict(),
    ),
  })
  .strict();
type Records = z.infer<typeof recordsSchema>;

/** Where a project came from, beside the runner's other state (ADR-0171). */
export const REMOTES_FILE = ".perch-remotes.json";

/**
 * Where the runner keeps what no member may change: the homes directory where members are isolated
 * (root's, and on the workspace's own volume), else the projects root (one person's machine).
 */
export function runnerStateDir(projectsRoot: string): string {
  return isolation()?.homesRoot ?? projectsRoot;
}

function readRecords(stateDir: string): Records {
  try {
    const parsed = recordsSchema.safeParse(
      JSON.parse(readFileSync(join(stateDir, REMOTES_FILE), "utf8")),
    );
    return parsed.success ? parsed.data : { version: 1, remotes: {} };
  } catch {
    return { version: 1, remotes: {} };
  }
}

/** The origin a project was cloned from (or first pushed to), as this runner recorded it. */
export function recordedOrigin(
  stateDir: string,
  workspaceId: string,
  projectId: string,
): RemoteOrigin | null {
  return readRecords(stateDir).remotes[`${workspaceId}/${projectId}`] ?? null;
}

/** Remembers where a project's remote is: the runner's own file, which no member can write. */
export function recordOrigin(
  stateDir: string,
  workspaceId: string,
  projectId: string,
  origin: RemoteOrigin,
): void {
  const records = readRecords(stateDir);
  records.remotes[`${workspaceId}/${projectId}`] = origin;
  const path = join(stateDir, REMOTES_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
