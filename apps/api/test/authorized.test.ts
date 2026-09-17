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

/**
 * Routes that answer without one, and why. Each is either public by design or scoped to the caller
 * themselves — and `requireUser` still stands in front of the ones that are not public.
 */
const EXEMPT: Record<string, string> = {
  "GET /api/health": "liveness, before anybody has signed in",
  "GET /api/version": "the build, which is public",
  "GET /api/instance": "which sign-in methods exist, read by the sign-in page",
  "POST /api/setup": "the wizard: it runs before there is anybody to authorize, and refuses twice",
  "GET /api/me": "the caller's own profile",
  "PATCH /api/me": "the caller's own profile",
  "GET /api/me/tokens": "the caller's own api tokens",
  "POST /api/me/tokens": "the caller's own api tokens",
  "DELETE /api/me/tokens/{id}": "the caller's own api tokens",
  "GET /api/me/push-key": "the instance's public VAPID key",
  "GET /api/me/push-subscriptions": "the caller's own devices",
  "POST /api/me/push-subscriptions": "the caller's own devices",
  "DELETE /api/me/push-subscriptions": "the caller's own devices",
  "GET /api/inbox": "the caller's own inbox rows, scoped by user id in the repository",
  "GET /api/workspaces": "the caller's own memberships",
  "POST /api/workspaces": "creating one: there is no resource to authorize against yet",
  "GET /api/invites/{token}": "the invite token is the authorization",
  "POST /api/invites/{token}/accept": "the invite token is the authorization",
  "GET /api/connect/callback/{provider}": "the OAuth state parameter is the authorization",
  "GET /api/templates":
    "the starter stacks (task 4.8): files in the build, the same for every workspace, with no resource to authorize against",
  "GET /api/hub":
    "the Hub's index (task 4.12): what this build ships, the same for every workspace; installing one of them is authorized as whatever it does",
  "GET {CIMD_PATH}":
    "the CIMD document (spec §3.5): this instance as an OAuth client, public by design",
};

/** The exempt routes that are open to anyone, signed in or not. */
const PUBLIC = new Set([
  "GET /api/health",
  "GET /api/version",
  "GET /api/instance",
  "POST /api/setup",
  "GET /api/me/push-key",
  "GET /api/invites/{token}",
  "GET /api/connect/callback/{provider}",
  "GET {CIMD_PATH}",
]);

type Handler = { key: string; body: string; middleware: string };

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

function readRoutes(): Handler[] {
  const handlers: Handler[] = [];
  const helpers = new Map<string, string>();
  const files = readdirSync(routesDir).filter((file) => file.endsWith(".ts"));

  for (const file of files) {
    const text = readFileSync(join(routesDir, file), "utf8");
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
      handlers.push({
        key: `${route.method} ${route.path}`,
        body: definitionBody(text, (match.index ?? 0) + match[0].length),
        middleware: route.middleware,
      });
    }
  }

  // A helper that calls a gate is a gate, up to a few levels of delegation.
  const gates = new Set<string>(GATES);
  for (let round = 0; round < 4; round += 1) {
    for (const [key, body] of helpers) {
      const name = key.split(":")[1] ?? "";
      if (!name || gates.has(name)) continue;
      if ([...gates].some((gate) => new RegExp(`\\b${gate}\\(`).test(body))) gates.add(name);
    }
  }
  return handlers.map((handler) => ({
    ...handler,
    body: [...gates].some((gate) => new RegExp(`\\b${gate}\\(`).test(handler.body))
      ? "GATED"
      : handler.body,
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

  test("an exemption that no longer matches a route is removed", () => {
    const keys = new Set(handlers.map((one) => one.key));
    expect(Object.keys(EXEMPT).filter((key) => !keys.has(key))).toEqual([]);
    expect([...PUBLIC].filter((key) => !keys.has(key))).toEqual([]);
  });

  test("every action the policy names has a row in the role matrix", () => {
    expect(Object.keys(ROLE_MATRIX).sort()).toEqual([...ACTIONS].sort());
  });
});
