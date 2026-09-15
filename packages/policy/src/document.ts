/**
 * The policy document (spec §5.7 ".perch/policy.yaml at workspace and project level"; task 2.11).
 *
 * One YAML file says what may happen here: which branches are protected, which commands are
 * refused, which paths an agent may write, which models a channel or a project may use, what may be
 * spent, and how far bots may go tagging each other. A workspace has one; a project may have its
 * own, which narrows the workspace's and never widens it.
 *
 * Pure: no database, no HTTP, no filesystem. The caller reads the documents and asks.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const pattern = z.string().min(1).max(500);

export const policySchema = z
  .object({
    /** The shape of this file. One, today. */
    version: z.literal(1).optional(),
    git: z
      .object({
        /** Branches nothing may push to. Globs: `main`, `release/*`. */
        protectedBranches: z.array(pattern).max(100).optional(),
        /** Whether a force push is allowed at all. Off by default. */
        allowForcePush: z.boolean().optional(),
      })
      .strict()
      .optional(),
    commands: z
      .object({
        /** Substrings or `/regex/` sources a command must not match. */
        deny: z.array(pattern).max(200).optional(),
      })
      .strict()
      .optional(),
    paths: z
      .object({
        /** Globs an agent may write. Absent means anywhere the runner allows. */
        allow: z.array(pattern).max(200).optional(),
        /** Globs an agent may never write, whatever `allow` says. */
        deny: z.array(pattern).max(200).optional(),
      })
      .strict()
      .optional(),
    models: z
      .object({
        /** Globs over `provider/model_id` and over profile names. Absent means anything. */
        allow: z.array(pattern).max(200).optional(),
        deny: z.array(pattern).max(200).optional(),
        /** Per channel, by name: `general: { allow: ["ollama/*"] }` — local models only. */
        channels: z
          .record(
            z.string().min(1),
            z
              .object({
                allow: z.array(pattern).max(200).optional(),
                deny: z.array(pattern).max(200).optional(),
              })
              .strict(),
          )
          .optional(),
        /** Per project, by key. */
        projects: z
          .record(
            z.string().min(1),
            z
              .object({
                allow: z.array(pattern).max(200).optional(),
                deny: z.array(pattern).max(200).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    budgets: z
      .object({
        /** Ceilings nothing here may exceed, whatever its own budget says. */
        dailyUsd: z.number().min(0).optional(),
        perRunUsd: z.number().min(0).optional(),
        perThreadUsd: z.number().min(0).optional(),
      })
      .strict()
      .optional(),
    secrets: z
      .object({
        /** Whether every diff is read before it is committed. On unless the workspace says no. */
        scan: z.boolean().optional(),
        /** Globs where a key-shaped string is the point: fixtures, examples, a scanner's tests. */
        ignorePaths: z.array(pattern).max(200).optional(),
        /** Rules to leave out, by id, when one of them keeps being wrong about this repo. */
        allowRules: z.array(pattern).max(100).optional(),
      })
      .strict()
      .optional(),
    bots: z
      .object({
        /** Whether bots may tag other bots at all (spec §5.4). */
        toBots: z.boolean().optional(),
        /** How far a chain may go from the message that started it. */
        maxHops: z.number().int().min(1).max(20).optional(),
        /** Channel names where bots may talk to each other. Absent means everywhere. */
        channels: z.array(pattern).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Policy = z.infer<typeof policySchema>;

export const EMPTY_POLICY: Policy = {};

/** Parses `.perch/policy.yaml`. An empty file is an empty policy, not an error. */
export function parsePolicy(text: string): Policy {
  const raw: unknown = text.trim() === "" ? {} : parseYaml(text);
  return policySchema.parse(raw ?? {});
}

/**
 * Layers a project's policy over its workspace's. The first layer is what it says; every layer
 * after it narrows and never widens — lists join, allow-lists shrink to the tighter one, ceilings
 * take the lower number, a switch that is off stays off, and one that is off by default cannot be
 * turned on further down. A project can tighten what it inherits, which is the only merge that
 * makes a policy mean anything.
 */
export function mergePolicies(...layers: readonly Policy[]): Policy {
  const [first, ...rest] = layers;
  let out: Policy = first ? structuredClone(first) : {};
  for (const layer of rest) out = narrowWith(out, layer);
  return prune(out);
}

function narrowWith(base: Policy, layer: Policy): Policy {
  return {
    git: {
      protectedBranches: join(base.git?.protectedBranches, layer.git?.protectedBranches),
      // Off by default (spec §5.7): a layer further down cannot turn a force push on.
      allowForcePush: base.git?.allowForcePush === true && layer.git?.allowForcePush !== false,
    },
    commands: { deny: join(base.commands?.deny, layer.commands?.deny) },
    paths: {
      allow: narrow(base.paths?.allow, layer.paths?.allow),
      deny: join(base.paths?.deny, layer.paths?.deny),
    },
    models: {
      allow: narrow(base.models?.allow, layer.models?.allow),
      deny: join(base.models?.deny, layer.models?.deny),
      channels: { ...base.models?.channels, ...layer.models?.channels },
      projects: { ...base.models?.projects, ...layer.models?.projects },
    },
    budgets: {
      dailyUsd: lower(base.budgets?.dailyUsd, layer.budgets?.dailyUsd),
      perRunUsd: lower(base.budgets?.perRunUsd, layer.budgets?.perRunUsd),
      perThreadUsd: lower(base.budgets?.perThreadUsd, layer.budgets?.perThreadUsd),
    },
    secrets: {
      // Only the workspace may turn scanning off: a project narrows, and this would loosen.
      scan: base.secrets?.scan,
      // Its own fixtures, though, a project does know about.
      ignorePaths: join(base.secrets?.ignorePaths, layer.secrets?.ignorePaths),
      allowRules: narrow(base.secrets?.allowRules, layer.secrets?.allowRules),
    },
    bots: {
      // On by default (spec §5.4): any layer saying no is what counts.
      toBots:
        base.bots?.toBots === false || layer.bots?.toBots === false ? false : base.bots?.toBots,
      maxHops: lower(base.bots?.maxHops, layer.bots?.maxHops),
      channels: narrow(base.bots?.channels, layer.bots?.channels),
    },
  };
}

function join(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a && !b) return undefined;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/** Two allow-lists narrow to what both allow; one allow-list is that one. */
function narrow(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a) return b ? [...b] : undefined;
  if (!b) return [...a];
  const both = a.filter((one) => b.includes(one));
  // Patterns that are not the same string still narrow: keep the tighter layer's list.
  return both.length > 0 ? both : [...b];
}

function lower(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Drops the empty objects the merge leaves behind, so a merged policy reads like a written one. */
function prune(policy: Policy): Policy {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(policy)) {
    if (value === undefined) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const inner: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        if (typeof v === "object" && v !== null && Object.keys(v).length === 0) continue;
        inner[k] = v;
      }
      if (Object.keys(inner).length > 0) out[key] = inner;
      continue;
    }
    out[key] = value;
  }
  return out as Policy;
}

export type PolicyRequest =
  | { kind: "git.push"; branch: string; force?: boolean }
  | { kind: "exec"; command: string }
  | { kind: "fs.write"; path: string }
  | {
      kind: "model";
      /** `provider/model_id`, and the profile's name when it has one. */
      ref: string;
      profile?: string;
      channel?: string;
      project?: string;
    }
  | { kind: "budget"; of: "dailyUsd" | "perRunUsd" | "perThreadUsd"; usd: number }
  | { kind: "bot.mention"; channel?: string; hop?: number };

export type PolicyDecision = { allow: true } | { allow: false; rule: string; reason: string };

const ALLOWED: PolicyDecision = { allow: true };

/** Turns a glob (`*`, `**`, `?`) into a regular expression anchored at both ends. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] ?? "";
    if (char === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i += 1;
        // `**/` also matches nothing at all, so `**/x` matches `x`.
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

export function matchesAny(value: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((glob) => globToRegExp(glob).test(value));
}

/** A denied command is a plain substring, or `/…/` for a regular expression. */
function commandMatches(command: string, pattern: string): boolean {
  const asRegex = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  if (asRegex) {
    try {
      return new RegExp(asRegex[1] ?? "", asRegex[2] || "i").test(command);
    } catch {
      return false;
    }
  }
  return command.toLowerCase().includes(pattern.toLowerCase());
}

/** What a scope allows and denies, once the channel's or project's own rules are layered on. */
function modelRules(
  policy: Policy,
  request: Extract<PolicyRequest, { kind: "model" }>,
): { allow?: string[] | undefined; deny?: string[] | undefined; where: string } {
  const channel = request.channel ? policy.models?.channels?.[request.channel] : undefined;
  const project = request.project ? policy.models?.projects?.[request.project] : undefined;
  const own = channel ?? project;
  const where = channel
    ? `models.channels.${request.channel}`
    : project
      ? `models.projects.${request.project}`
      : "models";
  return {
    allow: own?.allow ?? policy.models?.allow,
    deny: [...(policy.models?.deny ?? []), ...(own?.deny ?? [])],
    where: own ? where : "models",
  };
}

/** Allow or deny, with the rule that said so. Anything the document is silent about is allowed. */
export function evaluate(policy: Policy, request: PolicyRequest): PolicyDecision {
  switch (request.kind) {
    case "git.push": {
      if (request.force && policy.git?.allowForcePush !== true) {
        return {
          allow: false,
          rule: "git.allowForcePush",
          reason: "a force push is not allowed here",
        };
      }
      if (matchesAny(request.branch, policy.git?.protectedBranches)) {
        return {
          allow: false,
          rule: "git.protectedBranches",
          reason: `${request.branch} is a protected branch`,
        };
      }
      return ALLOWED;
    }
    case "exec": {
      const hit = (policy.commands?.deny ?? []).find((one) => commandMatches(request.command, one));
      return hit
        ? { allow: false, rule: "commands.deny", reason: `this command is refused here (${hit})` }
        : ALLOWED;
    }
    case "fs.write": {
      if (matchesAny(request.path, policy.paths?.deny)) {
        return { allow: false, rule: "paths.deny", reason: `${request.path} may not be written` };
      }
      const allow = policy.paths?.allow;
      if (allow && allow.length > 0 && !matchesAny(request.path, allow)) {
        return {
          allow: false,
          rule: "paths.allow",
          reason: `${request.path} is outside what may be written here`,
        };
      }
      return ALLOWED;
    }
    case "model": {
      const { allow, deny, where } = modelRules(policy, request);
      const names = [request.ref, ...(request.profile ? [request.profile] : [])];
      if (names.some((name) => matchesAny(name, deny))) {
        return {
          allow: false,
          rule: `${where}.deny`,
          reason: `${request.ref} is not allowed here`,
        };
      }
      if (allow && allow.length > 0 && !names.some((name) => matchesAny(name, allow))) {
        return {
          allow: false,
          rule: `${where}.allow`,
          reason: `${request.ref} is not on this ${request.channel ? "channel" : "workspace"}'s list of models`,
        };
      }
      return ALLOWED;
    }
    case "budget": {
      const ceiling = policy.budgets?.[request.of];
      if (ceiling !== undefined && request.usd > ceiling) {
        return {
          allow: false,
          rule: `budgets.${request.of}`,
          reason: `$${request.usd.toFixed(2)} is over the $${ceiling.toFixed(2)} ceiling here`,
        };
      }
      return ALLOWED;
    }
    case "bot.mention": {
      if (policy.bots?.toBots === false) {
        return { allow: false, rule: "bots.toBots", reason: "bots do not tag each other here" };
      }
      if (
        request.channel &&
        policy.bots?.channels &&
        policy.bots.channels.length > 0 &&
        !matchesAny(request.channel, policy.bots.channels)
      ) {
        return {
          allow: false,
          rule: "bots.channels",
          reason: `bots do not tag each other in #${request.channel}`,
        };
      }
      if (
        request.hop !== undefined &&
        policy.bots?.maxHops !== undefined &&
        request.hop > policy.bots.maxHops
      ) {
        return {
          allow: false,
          rule: "bots.maxHops",
          reason: `this thread has gone as far as it may (${policy.bots.maxHops} hops)`,
        };
      }
      return ALLOWED;
    }
    default:
      return ALLOWED;
  }
}
