import { describe, expect, test } from "bun:test";
import { evaluate, globToRegExp, mergePolicies, parsePolicy } from "../src/document.ts";

/** Task 2.11 (spec §5.7): the policy document, what it means, and what two of them mean together. */

const DOC = `
version: 1
git:
  protectedBranches: [main, "release/*"]
commands:
  deny: ["git push --force", "/npm\\\\s+publish/"]
paths:
  deny: [".env", "secrets/**"]
models:
  channels:
    general:
      allow: ["ollama/*"]
budgets:
  dailyUsd: 20
bots:
  maxHops: 4
`;

describe("the policy document", () => {
  test("a file is read, and an empty one is an empty policy", () => {
    const policy = parsePolicy(DOC);
    expect(policy.git?.protectedBranches).toEqual(["main", "release/*"]);
    expect(policy.budgets?.dailyUsd).toBe(20);
    expect(parsePolicy("")).toEqual({});
    expect(() => parsePolicy("nonsense: true")).toThrow();
  });

  test("globs match a path, a branch and a model, and stop at a slash unless doubled", () => {
    expect(globToRegExp("release/*").test("release/1.2")).toBe(true);
    expect(globToRegExp("release/*").test("release/1.2/hotfix")).toBe(false);
    expect(globToRegExp("secrets/**").test("secrets/deep/key.pem")).toBe(true);
    expect(globToRegExp("ollama/*").test("ollama/llama3.2")).toBe(true);
    expect(globToRegExp("ollama/*").test("openai/gpt-5")).toBe(false);
  });

  test("git: protected branches and force pushes", () => {
    const policy = parsePolicy(DOC);
    expect(evaluate(policy, { kind: "git.push", branch: "topic" })).toEqual({ allow: true });
    expect(evaluate(policy, { kind: "git.push", branch: "main" })).toMatchObject({
      allow: false,
      rule: "git.protectedBranches",
    });
    expect(evaluate(policy, { kind: "git.push", branch: "release/1.2" }).allow).toBe(false);
    // A force push is refused unless the document says otherwise — the acceptance for this task.
    expect(evaluate(policy, { kind: "git.push", branch: "topic", force: true })).toMatchObject({
      allow: false,
      rule: "git.allowForcePush",
    });
    expect(
      evaluate(
        { git: { allowForcePush: true } },
        { kind: "git.push", branch: "topic", force: true },
      ),
    ).toEqual({ allow: true });
  });

  test("commands: a substring, or a regular expression in slashes", () => {
    const policy = parsePolicy(DOC);
    expect(
      evaluate(policy, { kind: "exec", command: "git push --force origin main" }),
    ).toMatchObject({ allow: false, rule: "commands.deny" });
    expect(evaluate(policy, { kind: "exec", command: "npm   publish" }).allow).toBe(false);
    expect(evaluate(policy, { kind: "exec", command: "bun test" })).toEqual({ allow: true });
  });

  test("paths: a deny list, and an allow list that narrows to itself", () => {
    const policy = parsePolicy(DOC);
    expect(evaluate(policy, { kind: "fs.write", path: "src/index.ts" })).toEqual({ allow: true });
    expect(evaluate(policy, { kind: "fs.write", path: ".env" }).allow).toBe(false);
    expect(evaluate(policy, { kind: "fs.write", path: "secrets/prod/key.pem" }).allow).toBe(false);
    const only = { paths: { allow: ["src/**"] } };
    expect(evaluate(only, { kind: "fs.write", path: "src/a/b.ts" })).toEqual({ allow: true });
    expect(evaluate(only, { kind: "fs.write", path: "docs/a.md" })).toMatchObject({
      allow: false,
      rule: "paths.allow",
    });
  });

  test("models: a channel pinned to local models refuses a cloud one", () => {
    const policy = parsePolicy(DOC);
    expect(evaluate(policy, { kind: "model", ref: "ollama/llama3.2", channel: "general" })).toEqual(
      { allow: true },
    );
    const refused = evaluate(policy, {
      kind: "model",
      ref: "openai/gpt-5",
      profile: "Everyday",
      channel: "general",
    });
    expect(refused).toMatchObject({ allow: false, rule: "models.channels.general.allow" });
    // Elsewhere the same model is fine: the rule belongs to the channel, not the workspace.
    expect(evaluate(policy, { kind: "model", ref: "openai/gpt-5", channel: "random" })).toEqual({
      allow: true,
    });
    // A profile's name counts as a name the list can allow.
    expect(
      evaluate(
        { models: { allow: ["The big one"] } },
        { kind: "model", ref: "openai/gpt-5", profile: "The big one" },
      ),
    ).toEqual({ allow: true });
  });

  test("budgets and bot rails", () => {
    const policy = parsePolicy(DOC);
    expect(evaluate(policy, { kind: "budget", of: "dailyUsd", usd: 10 })).toEqual({ allow: true });
    expect(evaluate(policy, { kind: "budget", of: "dailyUsd", usd: 50 })).toMatchObject({
      allow: false,
      rule: "budgets.dailyUsd",
    });
    expect(evaluate(policy, { kind: "bot.mention", hop: 5 })).toMatchObject({
      allow: false,
      rule: "bots.maxHops",
    });
    expect(evaluate(policy, { kind: "bot.mention", hop: 3 })).toEqual({ allow: true });
    expect(evaluate({ bots: { toBots: false } }, { kind: "bot.mention" })).toMatchObject({
      allow: false,
      rule: "bots.toBots",
    });
    expect(
      evaluate({ bots: { channels: ["newsroom"] } }, { kind: "bot.mention", channel: "general" }),
    ).toMatchObject({ allow: false, rule: "bots.channels" });
  });

  test("a project narrows its workspace and never widens it", () => {
    const workspace = parsePolicy(DOC);
    const project = parsePolicy(`
git:
  protectedBranches: [develop]
  allowForcePush: true
budgets:
  dailyUsd: 5
bots:
  maxHops: 2
`);
    const merged = mergePolicies(workspace, project);
    // Lists join: both layers' protected branches are protected.
    expect(merged.git?.protectedBranches).toEqual(["main", "release/*", "develop"]);
    // A ceiling takes the lower number, and a switch the workspace never turned on stays off.
    expect(merged.budgets?.dailyUsd).toBe(5);
    expect(merged.bots?.maxHops).toBe(2);
    expect(evaluate(merged, { kind: "git.push", branch: "topic", force: true }).allow).toBe(false);
    // And what only the workspace said still holds.
    expect(evaluate(merged, { kind: "fs.write", path: ".env" }).allow).toBe(false);
    expect(mergePolicies()).toEqual({});
  });
});
