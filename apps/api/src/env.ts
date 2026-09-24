/**
 * Environment (spec §8): every PERCH_* variable with its default, validated with Zod at the boundary.
 * Laptop mode is inferred from a pglite:// DATABASE_URL; team mode requires PERCH_PUBLIC_URL and
 * PERCH_MASTER_KEY.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { generateMasterKey, parseMasterKey } from "@perch/vault";
import { z } from "zod";

const onOff = z
  .enum(["on", "off", "true", "false", "1", "0"])
  .transform((v) => v === "on" || v === "true" || v === "1");

const rawEnvSchema = z.object({
  PERCH_PUBLIC_URL: z.url().optional(),
  PERCH_PREVIEW_DOMAIN: z.string().min(1).optional(),
  /**
   * The command a runner spawns to give an agent eyes on a preview (spec §5.6 "@playwright/mcp in
   * the runner attached to sessions when a preview is open"; task 3.21, ADR-0139). Unset means the
   * feature is off: which build of `@playwright/mcp` matches the browser in a given runner image is
   * that operator's decision, not a version Perch pins on their behalf. `npx -y @playwright/mcp` is
   * the usual value; the hosted image sets one.
   */
  PERCH_PLAYWRIGHT_MCP: z.string().min(1).optional(),
  PERCH_MASTER_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).default("pglite://~/.perch/data"),
  PERCH_RUNNER_MODE: z.enum(["docker", "shared", "inprocess"]).optional(),
  PERCH_RUNNER_IMAGE: z.string().min(1).optional(),
  PERCH_RUNNER_LIMITS: z.string().default("cpus=2,memory=4g,pids=512"),
  PERCH_RUNNER_IDLE_MINUTES: z.coerce.number().int().positive().default(30),
  PERCH_RUNNER_API_URL: z.string().url().optional(),
  PERCH_RUNNER_HOMES_VOLUME: z.string().min(1).optional(),
  PERCH_RUNNER_PROJECTS_VOLUME: z.string().min(1).optional(),
  PERCH_RUNNER_NETWORK: z.string().min(1).optional(),
  PERCH_FILES_DIR: z.string().min(1).optional(),
  PERCH_S3_ENDPOINT: z.string().optional(),
  PERCH_S3_BUCKET: z.string().optional(),
  PERCH_S3_KEY: z.string().optional(),
  PERCH_S3_SECRET: z.string().optional(),
  PERCH_S3_REGION: z.string().optional(),
  PERCH_SMTP_URL: z.string().optional(),
  /** The From address on invite and reset mail; `Perch <no-reply@<public host>>` when unset. */
  PERCH_SMTP_FROM: z.string().min(3).optional(),
  /**
   * Addresses (IPs or CIDR ranges) or hostnames of the reverse proxies in front of the api, whose
   * X-Forwarded-For is believed (ADR-0172). Unset: loopback only. The compose file names `caddy`.
   */
  PERCH_TRUSTED_PROXIES: z.string().optional(),
  /**
   * Extra hostnames this instance answers to besides PERCH_PUBLIC_URL's, the preview domain,
   * loopback names and IP literals (ADR-0172: every other Host is refused, against DNS rebinding).
   */
  PERCH_ALLOWED_HOSTS: z.string().optional(),
  PERCH_TELEMETRY: onOff.default(false),
  PERCH_OTLP_ENDPOINT: z.url().optional(),
  PERCH_LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),
  PERCH_LOG_PRETTY: onOff.optional(),
  PERCH_SESSION_SECRET: z.string().min(16).optional(),
  PERCH_OIDC_ISSUER: z.url().optional(),
  PERCH_OIDC_CLIENT_ID: z.string().optional(),
  PERCH_OIDC_CLIENT_SECRET: z.string().optional(),
  PERCH_ALLOW_LOOPBACK_REDIRECTS: onOff.optional(),
  PERCH_DEFAULT_LOCALE: z.string().min(2).default("en"),
  PERCH_DEMO_WORKSPACE: onOff.optional(),
  /** Feature flags to turn on, comma-separated (spec §9.1; the instance setting `flags` wins). */
  PERCH_FLAGS: z.string().optional(),
  /** Where a local Ollama is, when it is not on the default port (task 1.15). */
  PERCH_OLLAMA_URL: z.string().optional(),
  /** Where a bot's web_search goes (task 2.6): a Brave-shaped endpoint, and the key it takes. */
  PERCH_SEARCH_URL: z.string().optional(),
  PERCH_SEARCH_KEY: z.string().optional(),
  PERCH_DATA_DIR: z.string().min(1).optional(),
  /**
   * Backups (task 4.4). A directory turns the nightly backup on; the cron is read in UTC, `KEEP`
   * is how many to keep, and `INCLUDE_KEY` decides whether the vault's master key is written into
   * the backup or only fingerprinted in its manifest.
   */
  PERCH_BACKUP_DIR: z.string().min(1).optional(),
  PERCH_BACKUP_CRON: z.string().min(1).default("0 3 * * *"),
  PERCH_BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(7),
  PERCH_BACKUP_INCLUDE_KEY: onOff.default(false),
  /**
   * A directory of connector manifests (`<id>/manifest.yaml`) read at boot, on top of the ones
   * this build ships (spec §5.5 "Everything else via manifests"; task 3.11). A provider added
   * here needs no rebuild, and one whose id matches a built-in replaces it.
   */
  PERCH_CONNECTORS_DIR: z.string().min(1).optional(),
  PERCH_COMMIT: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
});

export type PerchMode = "laptop" | "team";

export type Env = {
  mode: PerchMode;
  publicUrl: string;
  previewDomain: string | undefined;
  /** The command that gives an agent eyes on a preview (task 3.21); unset means off. */
  playwrightMcp: string | undefined;
  masterKey: string;
  sessionSecret: string;
  databaseUrl: string;
  dataDir: string;
  filesDir: string;
  runner: {
    mode: "docker" | "shared" | "inprocess";
    image: string;
    limits: string;
    idleMinutes: number;
    /** What runner containers reach the api at; the public URL when unset. */
    apiUrl: string | undefined;
    /** Volume and network names for runner containers; mirrored from the supervisor's own when unset. */
    homesVolume: string | undefined;
    projectsVolume: string | undefined;
    network: string | undefined;
  };
  s3: { endpoint: string; bucket: string; key: string; secret: string; region: string } | undefined;
  smtpUrl: string | undefined;
  smtpFrom: string | undefined;
  /** Proxies whose X-Forwarded-For is believed: IPs, CIDR ranges or hostnames (ADR-0172). */
  trustedProxies: readonly string[];
  /** Hostnames answered besides the public URL's, the preview domain's and loopback (ADR-0172). */
  allowedHosts: readonly string[];
  telemetry: boolean;
  /** Where to look for a local Ollama, beyond the default port. */
  ollamaUrls: readonly string[];
  /** The search endpoint a bot's web_search uses; without one the tool says it is not configured. */
  search: { url: string; key: string | undefined } | undefined;
  /** Where to read extra connector manifests from, when this instance has any (task 3.11). */
  connectorsDir: string | undefined;
  /**
   * Scheduled backups (task 4.4). `dir` unset means no schedule: a backup can still be taken by
   * hand, but nothing takes one on its own.
   */
  backup: {
    dir: string | undefined;
    cron: string;
    keep: number;
    /** Whether the master key travels with the backup, or only its fingerprint. */
    includeKey: boolean;
  };
  /** Flags PERCH_FLAGS turned on. */
  flags: string[];
  otlpEndpoint: string | undefined;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
  logPretty: boolean;
  oidc: { issuer: string; clientId: string; clientSecret: string } | undefined;
  allowLoopbackRedirects: boolean;
  defaultLocale: string;
  demoWorkspace: boolean;
  commit: string | undefined;
  port: number;
  host: string;
};

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

/** A comma-separated list, trimmed, without empty entries. */
function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function expandHome(p: string): string {
  return p.startsWith("~") ? `${homedir()}${p.slice(1)}` : p;
}

/**
 * In laptop mode the master key is generated on first run and kept at <dataDir>/master.key (spec §8:
 * "generated in laptop mode; required in team mode").
 */
function resolveMasterKey(mode: PerchMode, provided: string | undefined, dataDir: string): string {
  if (provided) {
    parseMasterKey(provided);
    return provided;
  }
  if (mode === "team") {
    throw new EnvError("PERCH_MASTER_KEY is required in team mode (openssl rand -base64 32)");
  }
  const keyPath = join(dataDir, "master.key");
  if (existsSync(keyPath)) return readFileSync(keyPath, "utf8").trim();
  const key = generateMasterKey();
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
  return key;
}

/** better-auth's secret is derived from the master key when PERCH_SESSION_SECRET is unset (spec §8). */
function deriveSessionSecret(masterKey: string): string {
  return new Bun.CryptoHasher("sha256").update(`perch-session:${masterKey}`).digest("base64");
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = rawEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new EnvError(`invalid environment: ${issues}`);
  }
  const raw = parsed.data;
  const mode: PerchMode = raw.DATABASE_URL.startsWith("pglite://") ? "laptop" : "team";
  const dataDir = resolve(expandHome(raw.PERCH_DATA_DIR ?? "~/.perch"));
  if (mode === "team" && !raw.PERCH_PUBLIC_URL) {
    throw new EnvError("PERCH_PUBLIC_URL is required in team mode");
  }
  const masterKey = resolveMasterKey(mode, raw.PERCH_MASTER_KEY, dataDir);
  const publicUrl = (raw.PERCH_PUBLIC_URL ?? `http://localhost:${raw.PORT}`).replace(/\/$/, "");
  const s3 =
    raw.PERCH_S3_ENDPOINT && raw.PERCH_S3_BUCKET && raw.PERCH_S3_KEY && raw.PERCH_S3_SECRET
      ? {
          endpoint: raw.PERCH_S3_ENDPOINT,
          bucket: raw.PERCH_S3_BUCKET,
          key: raw.PERCH_S3_KEY,
          secret: raw.PERCH_S3_SECRET,
          region: raw.PERCH_S3_REGION ?? "auto",
        }
      : undefined;
  const oidc =
    raw.PERCH_OIDC_ISSUER && raw.PERCH_OIDC_CLIENT_ID && raw.PERCH_OIDC_CLIENT_SECRET
      ? {
          issuer: raw.PERCH_OIDC_ISSUER,
          clientId: raw.PERCH_OIDC_CLIENT_ID,
          clientSecret: raw.PERCH_OIDC_CLIENT_SECRET,
        }
      : undefined;
  return {
    mode,
    publicUrl,
    previewDomain: raw.PERCH_PREVIEW_DOMAIN,
    playwrightMcp: raw.PERCH_PLAYWRIGHT_MCP,
    masterKey,
    sessionSecret: raw.PERCH_SESSION_SECRET ?? deriveSessionSecret(masterKey),
    databaseUrl: raw.DATABASE_URL,
    dataDir,
    filesDir: raw.PERCH_FILES_DIR ?? (mode === "laptop" ? join(dataDir, "files") : "/data/files"),
    runner: {
      mode: raw.PERCH_RUNNER_MODE ?? (mode === "laptop" ? "inprocess" : "docker"),
      image: raw.PERCH_RUNNER_IMAGE ?? "ghcr.io/12burb/perch-runner:latest",
      limits: raw.PERCH_RUNNER_LIMITS,
      idleMinutes: raw.PERCH_RUNNER_IDLE_MINUTES,
      apiUrl: raw.PERCH_RUNNER_API_URL,
      homesVolume: raw.PERCH_RUNNER_HOMES_VOLUME,
      projectsVolume: raw.PERCH_RUNNER_PROJECTS_VOLUME,
      network: raw.PERCH_RUNNER_NETWORK,
    },
    s3,
    smtpUrl: raw.PERCH_SMTP_URL,
    smtpFrom: raw.PERCH_SMTP_FROM,
    trustedProxies: list(raw.PERCH_TRUSTED_PROXIES),
    allowedHosts: list(raw.PERCH_ALLOWED_HOSTS).map((host) => host.toLowerCase()),
    telemetry: raw.PERCH_TELEMETRY,
    ollamaUrls: (raw.PERCH_OLLAMA_URL ?? "")
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean),
    connectorsDir: raw.PERCH_CONNECTORS_DIR,
    backup: {
      dir: raw.PERCH_BACKUP_DIR ? resolve(expandHome(raw.PERCH_BACKUP_DIR)) : undefined,
      cron: raw.PERCH_BACKUP_CRON,
      keep: raw.PERCH_BACKUP_KEEP,
      includeKey: raw.PERCH_BACKUP_INCLUDE_KEY,
    },
    search: raw.PERCH_SEARCH_URL
      ? { url: raw.PERCH_SEARCH_URL, key: raw.PERCH_SEARCH_KEY }
      : undefined,
    flags: (raw.PERCH_FLAGS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    otlpEndpoint: raw.PERCH_OTLP_ENDPOINT,
    logLevel: raw.PERCH_LOG_LEVEL,
    logPretty: raw.PERCH_LOG_PRETTY ?? false,
    oidc,
    allowLoopbackRedirects: raw.PERCH_ALLOW_LOOPBACK_REDIRECTS ?? mode === "laptop",
    defaultLocale: raw.PERCH_DEFAULT_LOCALE,
    demoWorkspace: raw.PERCH_DEMO_WORKSPACE ?? true,
    commit: raw.PERCH_COMMIT,
    port: raw.PORT,
    host: raw.HOST,
  };
}

/** The keys pino redacts from every log line (spec §9.1: secrets redacted by key list). */
export const REDACTED_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "secret",
  "client_secret",
  "api_key",
  "apiKey",
  "masterKey",
  "sessionSecret",
  "ciphertext",
  "privateKey",
  "private_key",
  "PERCH_MASTER_KEY",
  "PERCH_SESSION_SECRET",
  "PERCH_OIDC_CLIENT_SECRET",
  "PERCH_S3_SECRET",
] as const;
