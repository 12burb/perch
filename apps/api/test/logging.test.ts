import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Hono } from "hono";
import type { AppEnv } from "../src/context.ts";
import { createLogger, isSecretKey, requestLogger, scrubSecrets } from "../src/logging.ts";

/**
 * Spec §1.6 and §9.1: no token, key or password reaches a log line; secrets are redacted by key
 * name. These write through createLogger into a captured stream, so what is asserted is the line
 * an operator's log pipeline would receive.
 */

function capture(): { stream: Writable; lines: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, lines: () => chunks.join("") };
}

const SECRETS = [
  "top-token",
  "authz-header",
  "access-deep",
  "nested-auth",
  "nested-cookie",
  "deeper-token",
  "camel-access",
  "camel-refresh",
  "runner-token",
  "client-secret",
  "api-key-value",
  "err-config-auth",
  "child-binding-token",
  "array-token",
];

describe("createLogger redacts secrets by key name at any depth (§1.6)", () => {
  test("nested, camelCase, upper-case and error-carried secrets never reach the line", () => {
    const out = capture();
    const log = createLogger({ level: "info", destination: out.stream });
    const err = Object.assign(new Error("upstream said no"), {
      config: { headers: { authorization: "err-config-auth" } },
    });
    log.child({ sessionToken: "child-binding-token" }).info(
      {
        token: "top-token",
        authorization: "authz-header",
        connection: { tokens: { access_token: "access-deep" } },
        headers: { authorization: "nested-auth", cookie: "nested-cookie" },
        nested: { deeper: { still: { token: "deeper-token" } } },
        accessToken: "camel-access",
        refreshToken: "camel-refresh",
        PERCH_RUNNER_TOKEN: "runner-token",
        clientSecret: "client-secret",
        apiKey: "api-key-value",
        list: [{ token: "array-token" }],
        err,
        kept: "visible-value",
        usage: { input_tokens: 12 },
      },
      "a line",
    );
    const line = out.lines();
    for (const secret of SECRETS) expect(line).not.toContain(secret);
    expect(line).toContain("[redacted]");
    // What is not a secret stays readable, errors included.
    expect(line).toContain("visible-value");
    expect(line).toContain("upstream said no");
    expect(JSON.parse(line).usage).toEqual({ input_tokens: 12 });
  });

  test("the key rule: listed names and anything ending in token, secret, key or password", () => {
    for (const key of ["token", "Authorization", "set-cookie", "accessToken", "x_api_key"]) {
      expect(isSecretKey(key)).toBe(true);
    }
    for (const key of ["clientSecret", "PERCH_MASTER_KEY", "newPassword", "ciphertext"]) {
      expect(isSecretKey(key)).toBe(true);
    }
    for (const key of ["input_tokens", "tokenCount", "email", "workspace_id", "path"]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });

  test("scrubbing survives cycles and leaves the input untouched", () => {
    const loop: Record<string, unknown> = { token: "t", name: "n" };
    loop.self = loop;
    const scrubbed = scrubSecrets(loop) as Record<string, unknown>;
    expect(scrubbed.token).toBe("[redacted]");
    expect(scrubbed.name).toBe("n");
    expect(loop.token).toBe("t");
  });

  test("pretty output is available where the api is installed, and never throws at boot", () => {
    const out = capture();
    const log = createLogger({ level: "info", pretty: true, destination: out.stream });
    log.info({ token: "pretty-token" }, "pretty line");
    expect(out.lines()).toContain("pretty line");
    expect(out.lines()).not.toContain("pretty-token");
  });
});

describe("the request line never carries a token from the path (A-co-21)", () => {
  test("the route pattern is logged, not the concrete path", async () => {
    const out = capture();
    const log = createLogger({ level: "info", destination: out.stream });
    const app = new Hono<AppEnv>();
    app.use("*", requestLogger(log));
    app.get("/api/invites/:token", (c) => c.text("ok"));
    app.get("/api/runner/stream/:token", (c) => c.text("ok"));
    app.get("/api/auth/*", (c) => c.text("ok"));
    await app.request("/api/invites/inv_path-secret-1");
    await app.request("/api/runner/stream/stream-secret-2");
    await app.request("/api/auth/reset-password/reset-secret-3?callbackURL=%2F");
    await app.request("/api/nowhere/unmatched-secret-4");
    const lines = out.lines();
    for (const secret of [
      "path-secret-1",
      "stream-secret-2",
      "reset-secret-3",
      "unmatched-secret-4",
    ]) {
      expect(lines).not.toContain(secret);
    }
    expect(lines).toContain("/api/invites/:token");
    expect(lines).toContain("/api/runner/stream/:token");
  });
});
