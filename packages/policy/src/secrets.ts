/**
 * Secret scanning (spec §5.7 "secret scanning on every agent diff before commit"; task 2.12).
 *
 * An agent that writes a key into a file is one `git commit` away from a key in somebody's history,
 * and history is the one place a secret cannot be taken out of. So every diff is read before it is
 * committed, and a line that looks like a credential stops the commit until a person says otherwise.
 *
 * Pure, and only ever shown what it was given: the scanner returns where it found something and a
 * masked sample, never the secret itself.
 */

export type SecretRule = {
  /** What it is, in the words a card uses. */
  id: string;
  name: string;
  pattern: RegExp;
  /** A match this rule never counts: a placeholder, an example, a redacted value. */
  ignore?: RegExp;
};

/** A value nobody needs to worry about: a placeholder, an example, or something already masked. */
const PLACEHOLDER =
  /(x{6,}|\.{3,}|\*{4,}|<[^>]+>|\$\{[^}]+\}|\byour[-_]?|\bexample\b|\bplaceholder\b|\bredacted\b|\bchangeme\b|\bdummy\b|\bfake\b|\bsample\b|\btest[-_]?key\b)/i;

/**
 * What a credential looks like. Prefixed tokens first, because a provider's own prefix is the
 * strongest signal there is; then the shapes that need a name beside them to mean anything.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  { id: "aws.access_key", name: "an AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    id: "aws.secret_key",
    name: "an AWS secret access key",
    pattern: /\baws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})\b/i,
  },
  {
    id: "github.token",
    name: "a GitHub token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  },
  { id: "openai.key", name: "an OpenAI key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: "anthropic.key", name: "an Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/ },
  { id: "google.key", name: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "slack.token", name: "a Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    id: "stripe.key",
    name: "a Stripe secret key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  },
  { id: "npm.token", name: "an npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "hf.token", name: "a Hugging Face token", pattern: /\bhf_[A-Za-z0-9]{32,}\b/ },
  { id: "xai.key", name: "an xAI key", pattern: /\bxai-[A-Za-z0-9]{32,}\b/ },
  {
    id: "private_key",
    name: "a private key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    id: "connection_string",
    name: "a password in a connection string",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s:/@]{8,})@[^\s/]+/i,
  },
  {
    id: "generic.assignment",
    name: "something that reads like a secret",
    // `API_KEY = "…"`: a name that says secret, then a long value that is not a word.
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|credential|private[_-]?key)\w*\s*[=:]\s*["'`]([A-Za-z0-9/+_=-]{20,})["'`]/i,
  },
];

export type SecretFinding = {
  rule: string;
  name: string;
  /** The file the line was added to, as the diff names it. */
  path: string;
  /** Which added line it was, counting from one within the file's added lines. */
  line: number;
  /** Enough of it to recognise, never enough to use. */
  sample: string;
};

export type ScanOptions = {
  /** Files a finding is expected in: `.env.example`, fixtures, a scanner's own tests. */
  ignorePaths?: readonly string[];
  rules?: readonly SecretRule[];
};

/** Paths where a key-shaped string is the point rather than a mistake. */
export const DEFAULT_IGNORED_PATHS: readonly string[] = [
  "**/*.example",
  "**/*.example.*",
  "**/.env.example",
  "**/.env.sample",
  "**/*.snap",
  "**/fixtures/**",
  "**/__fixtures__/**",
  "**/testdata/**",
];

/** The first and last few characters, with the middle taken out. */
export function mask(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 12) return `${trimmed.slice(0, 2)}…`;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function globToRegExpLocal(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] ?? "";
    if (char === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

function ignored(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExpLocal(glob).test(path));
}

/** What one line of a diff says about the file it belongs to. */
function pathOf(line: string, current: string): string {
  const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
  if (header) return (header[1] ?? "").trim();
  const git = /^diff --git a\/.+ b\/(.+)$/.exec(line);
  if (git) return (git[1] ?? "").trim();
  return current;
}

/**
 * Reads a unified diff and answers with what it found in the lines being *added* — a secret being
 * taken out is not a secret being committed. One finding per rule per line, in the order they were
 * found, so a card reads top to bottom.
 */
export function scanDiff(diff: string, options: ScanOptions = {}): SecretFinding[] {
  const rules = options.rules ?? SECRET_RULES;
  const skip = options.ignorePaths ?? DEFAULT_IGNORED_PATHS;
  const findings: SecretFinding[] = [];
  let path = "";
  let added = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("diff --git") || raw.startsWith("+++")) {
      const next = pathOf(raw, path);
      if (next !== path) {
        path = next;
        added = 0;
      }
      continue;
    }
    if (raw.startsWith("@@") || raw.startsWith("---")) continue;
    if (!raw.startsWith("+")) continue;
    const text = raw.slice(1);
    added += 1;
    if (path === "/dev/null" || (path && ignored(path, skip))) continue;
    for (const rule of rules) {
      const match = rule.pattern.exec(text);
      if (!match) continue;
      const value = match[1] ?? match[0];
      if (PLACEHOLDER.test(value)) continue;
      if (rule.ignore?.test(text)) continue;
      findings.push({
        rule: rule.id,
        name: rule.name,
        path: path || "(unknown)",
        line: added,
        sample: mask(value),
      });
    }
  }
  return findings;
}

/** The same, for a file's whole content rather than a diff of it. */
export function scanText(path: string, text: string, options: ScanOptions = {}): SecretFinding[] {
  const body = text
    .split(/\r?\n/)
    .map((line) => `+${line}`)
    .join("\n");
  return scanDiff(`+++ b/${path}\n${body}`, options);
}
