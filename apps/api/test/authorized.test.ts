import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ACTIONS, ROLE_MATRIX } from "@perch/policy";

/**
 * Every route is authorized (task 4.5).
 *
 * A route that forgets `authorize()` is not a failing test anywhere else: it answers, correctly,
 * with somebody else's data. So this reads the route files themselves and asks, of every
 * `app.openapi(...)` handler, whether anything in it decides that this caller may do this — the
 * policy check, a scope check on the Bot API, the instance-admin guard, or a helper that calls one
 * of those. What is left over has to be named here, with the reason it needs no check.
 *
 * It is a static read rather than a runtime one because the question is about every route, and no
 * test suite exercises every route.
 */

const routesDir = resolve(import.meta.dir, "..", "src", "routes");

/** The calls that decide whether a caller may do something. */
const GATES = ["authorize", "enter", "guard"] as const;

/** The calls that apply an api token's scopes and workspace binding (ADR-0172). */
const TOKEN_GATES = ["tokenGate", "requireSession", "tokenAllows"] as const;

/**
 * How an exempt route treats an api token (ADR-0172). `authorize()` applies a token's scopes and
 * its workspace binding; a route that does not call it has to say what it does instead:
 * - `public`: there is no caller at all.
 * - `gated`: the handler calls tokenGate() or requireSession(); the text is the rule.
 * - `anyToken`: every token may, and the text is why nothing is exposed by that.
 */
type TokenRule = { public: string } | { gated: string } | { anyToken: string };

/**
 * Routes that answer without one, and why. Each is either public by design or scoped to the caller
 * themselves — and `requireUser` still stands in front of the ones that are not public.
 */
const EXEMPT: Record<string, { why: string; tokens: TokenRule }> = {
  "GET /api/health": {
    why: "liveness, before anybody has signed in",
    tokens: { public: "no caller" },
  },
  "GET /api/version": { why: "the build, which is public", tokens: { public: "no caller" } },
  "GET /api/instance": {
    why: "which sign-in methods exist, read by the sign-in page",
    tokens: { public: "no caller" },
  },
  "POST /api/setup": {
    why: "the wizard: it runs before there is anybody to authorize, and is claimed once",
    tokens: { public: "no caller" },
  },
  "GET /api/me": {
    why: "the caller's own profile",
    tokens: { anyToken: "who a token acts as is the one thing every token may ask" },
  },
  "PATCH /api/me": {
    why: "the caller's own profile",
    tokens: { gated: "admin scope, not bound: the profile spans every workspace" },
  },
  "GET /api/me/tokens": {
    why: "the caller's own api tokens",
    tokens: { gated: "read scope, not bound: the list names other workspaces" },
  },
  "POST /api/me/tokens": {
    why: "the caller's own api tokens",
    tokens: { gated: "a session only: a token never mints a token (ADR-0045)" },
  },
  "DELETE /api/me/tokens/{id}": {
    why: "the caller's own api tokens",
    tokens: { gated: "admin scope, not bound" },
  },
  "GET /api/me/push-key": {
    why: "the instance's public VAPID key",
    tokens: { public: "a public key" },
  },
  "GET /api/me/push-subscriptions": {
    why: "the caller's own devices",
    tokens: { gated: "read scope, not bound" },
  },
  "POST /api/me/push-subscriptions": {
    why: "the caller's own devices",
    tokens: { gated: "write scope, not bound: a device hears from every workspace" },
  },
  "DELETE /api/me/push-subscriptions": {
    why: "the caller's own devices",
    tokens: { gated: "write scope, not bound" },
  },
  "GET /api/inbox": {
    why: "the caller's own inbox rows, scoped by user id in the repository",
    tokens: { gated: "read scope; a bound token sees its workspace's rows only" },
  },
  "POST /api/inbox/{id}/resolve": {
    why: "the caller's own inbox row",
    tokens: { gated: "write scope; a bound token reaches its workspace's rows only" },
  },
  "POST /api/inbox/{id}/snooze": {
    why: "the caller's own inbox row",
    tokens: { gated: "write scope; a bound token reaches its workspace's rows only" },
  },
  "GET /api/workspaces": {
    why: "the caller's own memberships",
    tokens: { gated: "read scope; a bound token sees its own workspace only" },
  },
  "POST /api/workspaces": {
    why: "creating one: there is no resource to authorize against yet",
    tokens: { gated: "admin scope, not bound" },
  },
  "GET /api/invites/{token}": {
    why: "the invite token is the authorization",
    tokens: { public: "the invite token" },
  },
  "POST /api/invites/{token}/accept": {
    why: "the invite token is the authorization",
    tokens: { gated: "write scope, not bound: joining is past any one workspace" },
  },
  "GET /api/connect/callback/{provider}": {
    why: "the OAuth state parameter is the authorization",
    tokens: { public: "the OAuth state" },
  },
  "GET /api/templates": {
    why: "the starter stacks (task 4.8): files in the build, the same for every workspace, with no resource to authorize against",
    tokens: { anyToken: "what this build ships, the same for everybody" },
  },
  "GET /api/hub": {
    why: "the Hub's index (task 4.12): what this build ships, the same for every workspace; installing one of them is authorized as whatever it does",
    tokens: { anyToken: "what this build ships, the same for everybody" },
  },
  "GET {CIMD_PATH}": {
    why: "the CIMD document (spec §3.5): this instance as an OAuth client, public by design",
    tokens: { public: "a public document" },
  },
};

/** The exempt routes that are open to anyone, signed in or not. */
const PUBLIC = new Set(
  Object.entries(EXEMPT)
    .filter(([, entry]) => "public" in entry.tokens)
    .map(([key]) => key),
);

type Handler = { key: string; body: string; middleware: string; tokenGated: boolean };

/**
 * The body of a `name(...) {...}` or `name = (...) => {...}` definition, by brace matching.
 *
 * The opener is the first `{` that starts a line's block rather than one inside a type — a return
 * type like `Promise<{ item: WorkItem }>` sits on the same line as what follows it, and a block
 * does not.
 */
function definitionBody(text: string, from: number): string {
  const opener = /\{[ \t]*\r?\n/.exec(text.slice(from));
  const open = opener ? from + (opener.index ?? 0) : text.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/** Names this route file imports from a sibling route file. */
function siblingImports(text: string): Map<string, string> {
  const imported = new Map<string, string>();
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/([\w-]+\.ts)"/g)) {
    for (const name of (match[1] ?? "").split(",")) {
      const bare =
        name
          .replace(/^\s*type\s+/, "")
          .trim()
          .split(/\s+as\s+/)[0] ?? "";
      if (bare) imported.set(bare, match[2] ?? "");
    }
  }
  return imported;
}

/**
 * Which names in each file are gates: the given calls, plus any helper that calls one, up to a few
 * levels of delegation. A helper counts in its own file and in the files that import it by name —
 * two files each with their own `mine` are two different helpers.
 */
function gateNames(
  files: Map<string, string>,
  helpers: Map<string, string>,
  roots: readonly string[],
): Map<string, Set<string>> {
  const gated = new Set<string>(); // "file:name"
  const visible = (file: string): Set<string> => {
    const names = new Set<string>(roots);
    for (const key of gated) {
      const [owner = "", name = ""] = key.split(":");
      if (owner === file) names.add(name);
    }
    for (const [name, from] of siblingImports(files.get(file) ?? "")) {
      if (gated.has(`${from}:${name}`)) names.add(name);
    }
    return names;
  };
  for (let round = 0; round < 4; round += 1) {
    for (const [key, body] of helpers) {
      if (gated.has(key)) continue;
      const [file = ""] = key.split(":");
      if ([...visible(file)].some((gate) => new RegExp(`\\b${gate}\\(`).test(body))) gated.add(key);
    }
  }
  return new Map([...files.keys()].map((file) => [file, visible(file)]));
}

function calls(body: string, names: Set<string>): boolean {
  return [...names].some((name) => new RegExp(`\\b${name}\\(`).test(body));
}

function readRoutes(): Handler[] {
  const found: Array<Omit<Handler, "tokenGated"> & { file: string }> = [];
  const helpers = new Map<string, string>();
  const files = new Map<string, string>();

  for (const file of readdirSync(routesDir).filter((name) => name.endsWith(".ts"))) {
    const text = readFileSync(join(routesDir, file), "utf8");
    files.set(file, text);
    // Every function-shaped definition in the file, so a handler that delegates its check is seen.
    for (const match of text.matchAll(
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
    )) {
      const name = match[1] ?? match[2] ?? "";
      const body = definitionBody(text, (match.index ?? 0) + match[0].length);
      if (name && body) helpers.set(`${file}:${name}`, body);
    }

    const routes = new Map<string, { method: string; path: string; middleware: string }>();
    for (const match of text.matchAll(/const (\w+) = createRoute\(\{([\s\S]*?)\n\}\);/g)) {
      const definition = match[2] ?? "";
      // A path is usually a literal; `path: CIMD_PATH` is a constant, and is keyed by its name.
      const literal = /path:\s*"([^"]+)"/.exec(definition)?.[1];
      const constant = /path:\s*([A-Z_][A-Z0-9_]*)/.exec(definition)?.[1];
      routes.set(match[1] ?? "", {
        method: (/method:\s*"(\w+)"/.exec(definition)?.[1] ?? "?").toUpperCase(),
        path: literal ?? (constant ? `{${constant}}` : "?"),
        middleware: /middleware:\s*\[([^\]]*)\]/.exec(definition)?.[1] ?? "",
      });
    }
    for (const match of text.matchAll(/app\.openapi\((\w+),\s*(?:async\s*)?\(c\)/g)) {
      const route = routes.get(match[1] ?? "");
      if (!route) continue;
      found.push({
        file,
        key: `${route.method} ${route.path}`,
        body: definitionBody(text, (match.index ?? 0) + match[0].length),
        middleware: route.middleware,
      });
    }
  }

  const gates = gateNames(files, helpers, GATES);
  const tokenGates = gateNames(files, helpers, TOKEN_GATES);
  return found.map(({ file, ...handler }) => ({
    ...handler,
    body: calls(handler.body, gates.get(file) ?? new Set(GATES)) ? "GATED" : handler.body,
    tokenGated: calls(handler.body, tokenGates.get(file) ?? new Set(TOKEN_GATES)),
  }));
}

describe("every route is authorized (task 4.5)", () => {
  const handlers = readRoutes();

  test("the scan finds the routes it is supposed to", () => {
    expect(handlers.length).toBeGreaterThan(200);
    expect(handlers.map((one) => one.key)).toContain("GET /api/workspaces/{ws}/audit");
  });

  test("every handler decides whether this caller may do this, or says why it need not", () => {
    const ungated = handlers.filter((one) => one.body !== "GATED").map((one) => one.key);
    const unexplained = ungated.filter((key) => !(key in EXEMPT));
    expect(unexplained).toEqual([]);
  });

  test("an exemption that is not public still stands behind requireUser", () => {
    const anonymous = handlers
      .filter((one) => one.body !== "GATED" && !PUBLIC.has(one.key))
      .filter((one) => !one.middleware.includes("requireUser"))
      .map((one) => one.key);
    expect(anonymous).toEqual([]);
  });

  test("an exemption says how it treats an api token, and a gated one calls the gate (ADR-0172)", () => {
    const byKey = new Map(handlers.map((one) => [one.key, one]));
    const missing = Object.entries(EXEMPT)
      .filter(([, entry]) => "gated" in entry.tokens)
      .filter(([key]) => byKey.get(key)?.tokenGated !== true)
      .map(([key]) => key);
    expect(missing).toEqual([]);
    // A route that decides without authorize() and without a token rule would be an open door.
    const ungated = handlers.filter((one) => one.body !== "GATED" && !(one.key in EXEMPT));
    expect(ungated.map((one) => one.key)).toEqual([]);
  });

  test("an exemption that no longer matches a route is removed", () => {
    const keys = new Set(handlers.map((one) => one.key));
    expect(Object.keys(EXEMPT).filter((key) => !keys.has(key))).toEqual([]);
    expect([...PUBLIC].filter((key) => !keys.has(key))).toEqual([]);
  });

  test("every action the policy names has a row in the role matrix", () => {
    expect(Object.keys(ROLE_MATRIX).sort()).toEqual([...ACTIONS].sort());
  });
});
