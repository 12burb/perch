/**
 * The policy engine as the api sees it (spec §5.7; task 2.11).
 *
 * `@perch/policy` owns what a policy document means; this is the half that knows where the
 * documents are (the workspace's, and the project's narrowing it), keeps them parsed, and turns a
 * refusal into the two things a refusal has to be: an error the caller can read (451, spec §7.8)
 * and a `policy.violation` on the bus, which is what makes the card and the audit line.
 */
import type { Bus } from "@perch/bus";
import type { Db, Project } from "@perch/db";
import {
  DEFAULT_IGNORED_PATHS,
  EMPTY_POLICY,
  evaluate,
  mergePolicies,
  type Policy,
  type PolicyDecision,
  type PolicyRequest,
  parsePolicy,
  type SecretFinding,
  scanDiff,
} from "@perch/policy";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { findPolicy } from "../repos/policy.ts";

export type PolicyDeps = { db: Db; bus: Bus };

/** Who the refusal is about, so the violation says where it happened. */
export type PolicyScope = {
  workspaceId: string;
  project?: Project | undefined;
  subject?: { type: "user" | "bot" | "system"; id?: string | undefined } | undefined;
};

type Cached = { at: number; policy: Policy };

const CACHE_MS = 5_000;

export class PolicyService {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly deps: PolicyDeps) {}

  /** Forgets what it has read, which a write does so the next ask sees it. */
  forget(key?: string): void {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }

  /** The document a workspace is under, as it was written. */
  async yamlOf(workspaceId: string, projectId?: string | undefined): Promise<string> {
    const row = await findPolicy(this.deps.db, {
      workspaceId,
      ...(projectId ? { projectId } : {}),
    });
    return row?.yaml ?? "";
  }

  async workspacePolicy(workspaceId: string): Promise<Policy> {
    return this.cached(`ws:${workspaceId}`, async () => parse(await this.yamlOf(workspaceId)));
  }

  /** A project's policy is its workspace's, narrowed by its own. */
  async projectPolicy(project: Project): Promise<Policy> {
    const workspace = await this.workspacePolicy(project.workspaceId);
    const own = await this.cached(`project:${project.id}`, async () =>
      parse(await this.yamlOf(project.workspaceId, project.id)),
    );
    return Object.keys(own).length === 0 ? workspace : mergePolicies(workspace, own);
  }

  async policyFor(scope: PolicyScope): Promise<Policy> {
    return scope.project
      ? this.projectPolicy(scope.project)
      : this.workspacePolicy(scope.workspaceId);
  }

  /** Allow or deny, with the rule that said so. Nothing is written and nothing is published. */
  async evaluate(scope: PolicyScope, request: PolicyRequest): Promise<PolicyDecision> {
    return evaluate(await this.policyFor(scope), request);
  }

  /**
   * The enforcement point: a refusal is a 451 and a `policy.violation`, so every place that asks
   * behaves the same way and the audit log gets the line without the feature writing it.
   */
  async check(
    scope: PolicyScope,
    request: PolicyRequest,
    by: ActorContext,
  ): Promise<PolicyDecision> {
    const decision = await this.evaluate(scope, request);
    if (decision.allow) return decision;
    await this.violated(scope, request, decision, by);
    return decision;
  }

  /** The same, but it throws — for handlers, where a refusal is the end of the request. */
  async enforce(scope: PolicyScope, request: PolicyRequest, by: ActorContext): Promise<void> {
    const decision = await this.check(scope, request, by);
    if (!decision.allow) {
      throw new PerchError("policy_violation", decision.reason, {
        rule: decision.rule,
        kind: request.kind,
      });
    }
  }

  /** Says a rule refused something, once, wherever it was refused. */
  async violated(
    scope: PolicyScope,
    request: PolicyRequest,
    decision: Extract<PolicyDecision, { allow: false }>,
    by: ActorContext,
  ): Promise<void> {
    await this.deps.bus.publish(
      "policy.violation",
      {
        workspaceId: scope.workspaceId,
        rule: decision.rule,
        subjectType: scope.subject?.type ?? "user",
        ...(scope.subject?.id ? { subjectId: scope.subject.id } : {}),
        details: {
          kind: request.kind,
          reason: decision.reason,
          ...(scope.project ? { projectId: scope.project.id } : {}),
        },
      },
      by,
    );
  }

  /**
   * What a diff is about to commit (spec §5.7 "secret scanning on every agent diff before commit";
   * task 2.12). Findings are where and what, never the secret itself; `paths` narrows the answer to
   * the files this commit is actually taking.
   */
  async secretsIn(
    scope: PolicyScope,
    diff: string,
    paths?: readonly string[] | undefined,
  ): Promise<SecretFinding[]> {
    const policy = await this.policyFor(scope);
    if (policy.secrets?.scan === false) return [];
    const found = scanDiff(diff, {
      ignorePaths: [...DEFAULT_IGNORED_PATHS, ...(policy.secrets?.ignorePaths ?? [])],
    });
    const allowed = new Set(policy.secrets?.allowRules ?? []);
    const wanted = paths && paths.length > 0 ? new Set(paths) : null;
    return found.filter((one) => !allowed.has(one.rule) && (!wanted || wanted.has(one.path)));
  }

  private async cached(key: string, read: () => Promise<Policy>): Promise<Policy> {
    const found = this.cache.get(key);
    if (found && Date.now() - found.at < CACHE_MS) return found.policy;
    const policy = await read();
    this.cache.set(key, { at: Date.now(), policy });
    return policy;
  }
}

/** A document that will not parse is no policy at all: a broken file never opens the gates. */
function parse(yaml: string): Policy {
  if (!yaml.trim()) return EMPTY_POLICY;
  try {
    return parsePolicy(yaml);
  } catch {
    return EMPTY_POLICY;
  }
}
