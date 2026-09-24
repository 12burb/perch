/**
 * `perch init` (spec §8): writes .env (generated master key and Postgres password, the public URL,
 * the telemetry choice), the pinned docker-compose.yml, and the Caddyfile (with the preview wildcard
 * when a preview domain is given) into a directory. Interactive when a TTY is attached and a value
 * is missing; otherwise the flags are required.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateMasterKey } from "@perch/vault";
import caddyfile from "../../../../deploy/Caddyfile" with { type: "text" };
import caddyfilePreview from "../../../../deploy/Caddyfile.preview" with { type: "text" };
import compose from "../../../../deploy/docker-compose.yml" with { type: "text" };
import { CLI_VERSION } from "../version.ts";

const HELP = `perch init [options]

Options:
  --dir <path>              where to write the files (default: ./perch)
  --public-url <url>        PERCH_PUBLIC_URL, the URL people will use (https://perch.example.com)
  --preview-domain <host>   PERCH_PREVIEW_DOMAIN for wildcard previews (optional)
  --dns-provider <name>     Caddy DNS-challenge provider for the wildcard (default: cloudflare)
  --dns-token <token>       the provider token (optional; can be added to .env later)
  --telemetry               opt in to the daily anonymous ping (off by default; the wizard asks too)
  --image-tag <tag>         perch image tag to pin (default: this CLI's version)
  --force                   overwrite files that already exist
  --yes                     never prompt; fail when a required value is missing
  -h, --help                show this help`;

export type InitOptions = {
  dir: string;
  publicUrl: string;
  previewDomain?: string;
  dnsProvider: string;
  dnsToken?: string;
  telemetry: boolean;
  imageTag: string;
  force: boolean;
};

export type InitFiles = { env: string; compose: string; caddyfile: string };

function randomPassword(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

/** Renders the three files; pure so tests can check the exact output. */
export function renderInit(
  options: InitOptions,
  secrets = { masterKey: generateMasterKey(), postgresPassword: randomPassword() },
): InitFiles {
  const url = new URL(options.publicUrl);
  const lines = [
    "# Written by perch init. Keep this file private; PERCH_MASTER_KEY encrypts every credential.",
    `PERCH_PUBLIC_URL=${url.origin}`,
    `PERCH_MASTER_KEY=${secrets.masterKey}`,
    `POSTGRES_PASSWORD=${secrets.postgresPassword}`,
    `PERCH_IMAGE_TAG=${options.imageTag}`,
    `PERCH_TELEMETRY=${options.telemetry ? "on" : "off"}`,
    "PERCH_RUNNER_MODE=docker",
    "PERCH_LOG_LEVEL=info",
  ];
  if (options.previewDomain) {
    lines.push(
      `PERCH_PREVIEW_DOMAIN=${options.previewDomain}`,
      `CADDY_DNS_PROVIDER=${options.dnsProvider}`,
      `CADDY_DNS_TOKEN=${options.dnsToken ?? ""}`,
    );
  } else {
    lines.push("# PERCH_PREVIEW_DOMAIN=preview.example.com  (unset: previews use path mode)");
  }
  lines.push(
    "# PERCH_SMTP_URL=smtp://user:pass@host:587    (unset: no mail; invite links are shown to the inviter)",
  );
  return {
    env: `${lines.join("\n")}\n`,
    compose,
    caddyfile: options.previewDomain ? caddyfilePreview : caddyfile,
  };
}

export function writeInit(options: InitOptions, files: InitFiles): string[] {
  const dir = resolve(options.dir);
  mkdirSync(dir, { recursive: true });
  const targets: Array<[string, string]> = [
    [".env", files.env],
    ["docker-compose.yml", files.compose],
    ["Caddyfile", files.caddyfile],
  ];
  const written: string[] = [];
  for (const [name, content] of targets) {
    const path = join(dir, name);
    if (existsSync(path) && !options.force) {
      throw new Error(`${path} exists; pass --force to overwrite`);
    }
    writeFileSync(path, content, { mode: name === ".env" ? 0o600 : 0o644 });
    written.push(path);
  }
  return written;
}

async function ask(question: string, fallback?: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return fallback;
  const answer = prompt(fallback ? `${question} [${fallback}]` : question);
  return answer?.trim() || fallback;
}

export async function runInit(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      "public-url": { type: "string" },
      "preview-domain": { type: "string" },
      "dns-provider": { type: "string" },
      "dns-token": { type: "string" },
      telemetry: { type: "boolean" },
      "image-tag": { type: "string" },
      force: { type: "boolean" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const interactive = !values.yes && process.stdin.isTTY;
  const publicUrl =
    values["public-url"] ??
    (interactive ? await ask("Public URL (https://perch.example.com)") : undefined);
  if (!publicUrl) {
    console.error(`--public-url is required (or run perch init in a terminal)\n\n${HELP}`);
    return 2;
  }
  try {
    new URL(publicUrl);
  } catch {
    console.error(`not a URL: ${publicUrl}`);
    return 2;
  }
  const previewDomain =
    values["preview-domain"] ??
    (interactive ? await ask("Preview wildcard domain (blank for path mode)") : undefined);
  let telemetry = values.telemetry ?? false;
  if (values.telemetry === undefined && interactive) {
    telemetry = confirm("Send a daily anonymous ping (docs/telemetry.md lists every field)?");
  }
  const options: InitOptions = {
    dir: values.dir ?? "./perch",
    publicUrl,
    ...(previewDomain ? { previewDomain } : {}),
    dnsProvider: values["dns-provider"] ?? "cloudflare",
    ...(values["dns-token"] ? { dnsToken: values["dns-token"] } : {}),
    telemetry,
    imageTag: values["image-tag"] ?? CLI_VERSION,
    force: values.force ?? false,
  };
  try {
    const written = writeInit(options, renderInit(options));
    console.log(
      `wrote\n  ${written.join("\n  ")}\n\nnext: cd ${options.dir} && docker compose up -d, then open ${new URL(publicUrl).origin} to finish setup.`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
