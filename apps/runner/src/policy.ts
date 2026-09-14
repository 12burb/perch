/**
 * Policy hooks on a runner (spec §5.7 "Policy engine", task 1.5, ADR-0070): every fs, git, and exec
 * method asks one function before it acts. The built-in rules are the floor a runner enforces on its
 * own (destructive commands, package publishes, force pushes, git internals, exec confined to the
 * projects root); the .perch/policy.yaml evaluator of task 2.11 layers workspace and project rules
 * on top through the same hook.
 */
import { JSON_RPC_ERRORS } from "@perch/events";

export type PolicyRequest =
  | { kind: "fs.read" | "fs.list" | "fs.stat" | "fs.search"; project: string; path: string }
  | { kind: "fs.write"; project: string; path: string }
  | { kind: "exec"; command: string; cwd: string; root: string }
  | { kind: "git.push"; project: string; branch: string }
  | { kind: "git.commit"; project: string; paths: string[] }
  | { kind: "git.branch" | "worktree.create" | "worktree.remove"; project: string; branch: string };

export type PolicyDecision = { allow: true } | { allow: false; reason: string };
export type RunnerPolicy = (request: PolicyRequest) => PolicyDecision;

export type PolicyRules = {
  /** Regexes (or regex sources) an exec command must not match. */
  deniedCommands?: (RegExp | string)[];
  /** Branches git.push refuses. */
  protectedBranches?: string[];
  /** Project-relative globs fs.write must not touch; reads still work. */
  readOnlyPaths?: string[];
  /** Whether exec may run outside the projects root (local runners: the owner's machine). */
  execAnywhere?: boolean;
};

/** What no agent gets to run through a runner by default (spec §5.7's examples and their kin). */
/** Where a command word starts: the line, after a separator, or after sudo/env/nohup/time. */
const CMD = String.raw`(^|[;&|(]\s*|\b(sudo|env|nohup|time|exec)\s+)`;

export const DEFAULT_DENIED_COMMANDS: RegExp[] = [
  // rm -r/-f (any flag order) on the root, a home, the parent, the project itself, or everything
  new RegExp(String.raw`${CMD}rm\s+(-\S+\s+)*(\/\*?|~\/?|\$HOME\/?|\.\.\/?|\.|\*)(\s|$)`),
  /\bgit\s+push\b.*\s(--force|-f|--force-with-lease(=\S*)?|--delete|-d)(\s|$)/,
  /\bgit\s+push\b.*\s\+\S+/,
  /\b(npm|pnpm|yarn|bun)\s+publish\b/,
  /\bcargo\s+publish\b/,
  /\bgem\s+push\b/,
  /\btwine\s+upload\b/,
  /\bdocker\s+push\b/,
  new RegExp(String.raw`${CMD}mkfs(\.\w+)?(\s|$)`),
  new RegExp(String.raw`${CMD}dd\s+.*\bif=`),
  new RegExp(String.raw`${CMD}(shutdown|reboot|halt|poweroff)(\s|$)`),
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  new RegExp(String.raw`${CMD}chmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)`),
];

/** git internals are managed by git.*; fs.write keeps its hands off them. */
export const DEFAULT_READ_ONLY_PATHS = [".git", ".git/**"];

export class PolicyDenied extends Error {
  readonly code = JSON_RPC_ERRORS.policyViolation;
  constructor(reason: string) {
    super(`policy denied: ${reason}`);
    this.name = "PolicyDenied";
  }
}

function toRegExp(pattern: RegExp | string): RegExp {
  return pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");
}

function matchesGlob(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(path));
}

function inside(root: string, dir: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  return (
    dir === normalizedRoot ||
    dir.startsWith(`${normalizedRoot}/`) ||
    dir.startsWith(`${normalizedRoot}\\`)
  );
}

export function runnerPolicy(rules: PolicyRules = {}): RunnerPolicy {
  const denied = (rules.deniedCommands ?? DEFAULT_DENIED_COMMANDS).map(toRegExp);
  const protectedBranches = new Set(rules.protectedBranches ?? []);
  const readOnly = rules.readOnlyPaths ?? DEFAULT_READ_ONLY_PATHS;
  return (request) => {
    switch (request.kind) {
      case "exec": {
        const hit = denied.find((re) => re.test(request.command));
        if (hit)
          return { allow: false, reason: `command matches a denied pattern (${hit.source})` };
        if (!rules.execAnywhere && !inside(request.root, request.cwd)) {
          return { allow: false, reason: "exec runs inside the projects root only" };
        }
        return { allow: true };
      }
      case "fs.write":
        if (matchesGlob(request.path, readOnly)) {
          return { allow: false, reason: `${request.path} is read-only through fs.write` };
        }
        return { allow: true };
      case "git.push":
        if (protectedBranches.has(request.branch)) {
          return { allow: false, reason: `${request.branch} is a protected branch` };
        }
        return { allow: true };
      case "git.commit":
        return { allow: true };
      default:
        return { allow: true };
    }
  };
}

/** Throws PolicyDenied (JSON-RPC -32451) when the policy says no. */
export function enforce(policy: RunnerPolicy, request: PolicyRequest): void {
  const decision = policy(request);
  if (!decision.allow) throw new PolicyDenied(decision.reason);
}
