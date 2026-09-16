/**
 * Upgrading the `perch` binary in place (task 4.3).
 *
 * The rule here is that nothing is trusted because it came from the internet: an asset is written
 * only after its SHA-256 matches the line for it in the release's own `SHA256SUMS`, and that
 * checksum file is itself signed by the release workflow with cosign (keyless, Sigstore) — so when
 * cosign is on this machine the signature is checked too, and `--require-signature` refuses an
 * upgrade that cannot be checked that far. The binary being replaced is kept until the new one is
 * in place. The same asset names, checksum file and signature are what `install.sh` and
 * `install.ps1` use, so there is one way to get a Perch and one way to check it.
 *
 * Everything is a function over a `fetch` and a directory, so a test can stand up a release server
 * on this machine and watch a real upgrade happen.
 */
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Where the releases are, unless somebody points this somewhere else. */
export const RELEASES = "https://api.github.com/repos/12burb/perch/releases";

/** Who signed a release: GitHub Actions running this repository's release workflow. */
export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";

export type Platform = "linux" | "darwin" | "win32";
export type Arch = "x64" | "arm64";

export class UpgradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpgradeError";
  }
}

/**
 * The asset this machine wants. The names are `scripts/build-cli.ts`'s, which is what the release
 * uploads: `perch-linux-x64`, `perch-darwin-arm64`, `perch-windows-x64.exe`.
 */
export function assetFor(platform: string, arch: string): string {
  const cpu = arch === "arm64" || arch === "aarch64" ? "arm64" : "x64";
  if (platform === "win32" || platform === "windows") {
    if (cpu !== "x64") throw new UpgradeError("Perch ships one Windows binary, and it is x64");
    return "perch-windows-x64.exe";
  }
  if (platform === "darwin") return `perch-darwin-${cpu}`;
  if (platform === "linux") return `perch-linux-${cpu}`;
  throw new UpgradeError(`there is no Perch binary for ${platform}`);
}

export type Release = {
  /** The tag, as the release names it: `v0.2.0`. */
  tag: string;
  /** Asset name → where to download it. */
  assets: Record<string, string>;
};

type GitHubRelease = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
};

/** What a GitHub release answer says, narrowed to what an upgrade needs. */
export function toRelease(body: unknown): Release {
  const release = body as GitHubRelease;
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  if (!tag) throw new UpgradeError("that release has no tag");
  const assets: Record<string, string> = {};
  for (const asset of Array.isArray(release.assets) ? release.assets : []) {
    const one = asset as { name?: unknown; browser_download_url?: unknown };
    if (typeof one.name === "string" && typeof one.browser_download_url === "string") {
      assets[one.name] = one.browser_download_url;
    }
  }
  return { tag, assets };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The newest release that is not a draft. */
export async function latestRelease(options: {
  fetch?: FetchLike;
  releases?: string;
}): Promise<Release> {
  const call = options.fetch ?? fetch;
  const url = `${options.releases ?? RELEASES}/latest`;
  const response = await call(url, { headers: { accept: "application/vnd.github+json" } });
  if (!response.ok) {
    throw new UpgradeError(`could not ask ${url} what the latest release is (${response.status})`);
  }
  return toRelease(await response.json());
}

/** `…/repos/owner/repo/releases` → `owner/repo`, which is who the signature must name. */
export function repoFrom(releases: string): string {
  const match = /\/repos\/([^/]+\/[^/]+)\/releases/.exec(releases);
  return match?.[1] ?? "12burb/perch";
}

/** `<sha256>  <name>` per line, the way `sha256sum` writes it. */
export function checksumsFrom(text: string): Record<string, string> {
  const sums: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (match?.[1] && match[2]) sums[match[2]] = match[1].toLowerCase();
  }
  return sums;
}

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Whether these bytes are the ones the release says they are. */
export function matches(bytes: Uint8Array, sums: Record<string, string>, name: string): boolean {
  const expected = sums[name];
  return expected !== undefined && expected === sha256(bytes);
}

/** The version this binary was built as; `dev` when it was not built at all. */
export function currentVersion(): string {
  return process.env.PERCH_VERSION ?? "dev";
}

/** `v0.2.0` and `0.2.0` are the same version, said two ways. */
export function sameVersion(tag: string, version: string): boolean {
  return tag.replace(/^v/, "") === version.replace(/^v/, "");
}

/** What came of checking who signed the checksums. */
export type SignatureCheck = "verified" | "no-cosign" | "unsigned";

/**
 * Checks the release's signature over `SHA256SUMS` with cosign.
 *
 * Sigstore verification is a lot of cryptography to reimplement badly, so this shells out to the
 * cosign the machine already has and says plainly when it has none. The identity is pinned: only
 * this repository's release workflow, through GitHub's OIDC issuer, counts as a signature.
 */
export function verifySums(options: {
  /** The files, already downloaded. */
  sums: string;
  signature: string;
  certificate: string;
  repo: string;
  /** The cosign to use; looked up on PATH when this is not given. */
  cosign?: string | undefined;
}): SignatureCheck {
  const cosign = options.cosign ?? Bun.which("cosign");
  if (!cosign) return "no-cosign";
  const identity = `^https://github\\.com/${options.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.github/workflows/release\\.yml@`;
  const proc = Bun.spawnSync(
    [
      cosign,
      "verify-blob",
      "--signature",
      options.signature,
      "--certificate",
      options.certificate,
      "--certificate-identity-regexp",
      identity,
      "--certificate-oidc-issuer",
      OIDC_ISSUER,
      options.sums,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new UpgradeError(
      `the signature over SHA256SUMS is not ${options.repo}'s release workflow; nothing was installed: ${proc.stderr.toString().trim() || `cosign exited with ${proc.exitCode}`}`,
    );
  }
  return "verified";
}

export type UpgradeResult = {
  /** What it was, and what it is now. */
  from: string;
  to: string;
  /** Where the binary ended up. */
  path: string;
  /** True when there was nothing to do. */
  already: boolean;
  /** How far the release could be checked. */
  signature: SignatureCheck;
};

/**
 * Downloads the release's binary for this machine, checks it against the release's own checksums
 * (and their signature, where cosign can), and puts it where the running binary is.
 *
 * The old binary is moved aside rather than deleted, because on Windows a running executable
 * cannot be overwritten but *can* be renamed — which is what makes an in-place upgrade possible at
 * all. The moved-aside copy is removed on the platforms where that is allowed.
 */
export async function upgrade(options: {
  /** The binary to replace. Defaults to the one running this. */
  target?: string;
  platform?: string;
  arch?: string;
  fetch?: FetchLike;
  releases?: string;
  /** Upgrade even when the release is the version already installed. */
  force?: boolean;
  /** Refuse an upgrade whose checksums carry no signature this machine can check. */
  requireSignature?: boolean;
  /** The cosign to check the signature with; PATH's, when this is not given. */
  cosign?: string;
  version?: string;
  log?: (line: string) => void;
}): Promise<UpgradeResult> {
  const say = options.log ?? (() => {});
  const call = options.fetch ?? fetch;
  const target = options.target ?? process.execPath;
  const from = options.version ?? currentVersion();
  const releases = options.releases ?? RELEASES;

  const release = await latestRelease({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    releases,
  });
  if (!options.force && sameVersion(release.tag, from)) {
    return { from, to: release.tag, path: target, already: true, signature: "unsigned" };
  }

  const name = assetFor(options.platform ?? process.platform, options.arch ?? process.arch);
  const url = release.assets[name];
  const sumsUrl = release.assets.SHA256SUMS;
  if (!url) throw new UpgradeError(`${release.tag} has no ${name}`);
  if (!sumsUrl) throw new UpgradeError(`${release.tag} has no SHA256SUMS to check ${name} against`);

  say(`downloading ${name} from ${release.tag}`);
  const [binary, sums] = await Promise.all([call(url), call(sumsUrl)]);
  if (!binary.ok) throw new UpgradeError(`could not download ${name} (${binary.status})`);
  if (!sums.ok) throw new UpgradeError(`could not download SHA256SUMS (${sums.status})`);
  const bytes = new Uint8Array(await binary.arrayBuffer());
  const sumsText = await sums.text();
  const expected = checksumsFrom(sumsText);
  if (!matches(bytes, expected, name)) {
    // The one thing this must never do is install what it cannot vouch for.
    throw new UpgradeError(
      `${name} does not match the checksum ${release.tag} published for it; nothing was installed`,
    );
  }

  const signature = await checkSignature({
    release,
    sumsText,
    call,
    repo: repoFrom(releases),
    ...(options.cosign === undefined ? {} : { cosign: options.cosign }),
  });
  if (signature !== "verified" && options.requireSignature) {
    throw new UpgradeError(
      signature === "no-cosign"
        ? "--require-signature needs cosign on this machine (https://docs.sigstore.dev); nothing was installed"
        : `${release.tag} published no signature over its SHA256SUMS; nothing was installed`,
    );
  }
  say(
    signature === "verified"
      ? "the checksums are signed by the release workflow"
      : signature === "no-cosign"
        ? "the checksum matched; install cosign to check the signature too"
        : "the checksum matched; this release published no signature",
  );

  const directory = dirname(target);
  const staged = join(directory, `.${name}.new`);
  const previous = `${target}.old`;
  writeFileSync(staged, bytes);
  chmodSync(staged, 0o755);
  // Move the running binary aside, then the new one into its place. If the second step fails the
  // old one goes back, so a failed upgrade leaves a working Perch.
  rmSync(previous, { force: true });
  renameSync(target, previous);
  try {
    renameSync(staged, target);
  } catch (error) {
    renameSync(previous, target);
    rmSync(staged, { force: true });
    throw new UpgradeError(
      `could not put the new binary in place: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Windows will not delete a running image; leaving it is tidier than failing over it.
  try {
    rmSync(previous, { force: true });
  } catch {
    say(`the old binary is at ${previous} and can be deleted once this process exits`);
  }
  say(`perch is now ${release.tag}`);
  return { from, to: release.tag, path: target, already: false, signature };
}

/** Downloads the cosign bundle beside SHA256SUMS, if the release has one, and checks it. */
async function checkSignature(options: {
  release: Release;
  sumsText: string;
  call: FetchLike;
  repo: string;
  cosign?: string;
}): Promise<SignatureCheck> {
  const sigUrl = options.release.assets["SHA256SUMS.sig"];
  const pemUrl = options.release.assets["SHA256SUMS.pem"];
  if (!sigUrl || !pemUrl) return "unsigned";
  const [sig, pem] = await Promise.all([options.call(sigUrl), options.call(pemUrl)]);
  if (!sig.ok || !pem.ok) return "unsigned";
  const dir = mkdtempSync(join(tmpdir(), "perch-upgrade-"));
  try {
    writeFileSync(join(dir, "SHA256SUMS"), options.sumsText);
    writeFileSync(join(dir, "SHA256SUMS.sig"), await sig.text());
    writeFileSync(join(dir, "SHA256SUMS.pem"), await pem.text());
    return verifySums({
      sums: join(dir, "SHA256SUMS"),
      signature: join(dir, "SHA256SUMS.sig"),
      certificate: join(dir, "SHA256SUMS.pem"),
      repo: options.repo,
      cosign: options.cosign,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
