import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPerchClient } from "@perch/api-client";
import { errorResponseSchema } from "@perch/events";
import type { Booted } from "../src/boot.ts";
import { API_VERSION } from "../src/context.ts";
import { loadEnv } from "../src/env.ts";
import { bootTestApp } from "../src/testing.ts";

let booted: Booted;

/** The generated client pointed at the in-process app (no socket). */
const client = () =>
  createPerchClient({
    baseUrl: "http://perch.test",
    fetch: (request: Request) => Promise.resolve(booted.app.request(request)),
  });

beforeAll(async () => {
  booted = await bootTestApp();
}, 60_000);

afterAll(async () => {
  await booted.close();
});

describe("apps/api skeleton (task 0.7)", () => {
  test("GET /api/health is typed end to end through the generated client", async () => {
    const { data, error, response } = await client().GET("/api/health");
    expect(error).toBeUndefined();
    expect(response.status).toBe(200);
    // `data` is typed from the OpenAPI document: status is "ok" | "degraded", checks.database exists.
    expect(data?.status).toBe("ok");
    expect(data?.checks.database).toBe("ok");
    expect(Date.parse(data?.ts ?? "")).toBeGreaterThan(0);
    expect(response.headers.get("perch-version")).toBe(API_VERSION);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("GET /api/version reports the build, contract version, runtime, and mode", async () => {
    const { data } = await client().GET("/api/version");
    expect(data?.api_version).toBe(API_VERSION);
    expect(data?.runtime).toBe(`bun ${Bun.version}`);
    expect(data?.mode).toBe("laptop");
  });

  test("the OpenAPI document is served and the committed copy matches it", async () => {
    const res = await booted.app.request("/api/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      servers: unknown;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/api/health", "/api/version"]));
    const committed = JSON.parse(
      readFileSync(
        resolve(import.meta.dir, "..", "..", "..", "packages", "api-client", "openapi.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    doc.servers = [{ url: "/" }];
    expect(committed).toEqual(doc);
  });

  test("errors use the §7.8 shape with a request id; unknown routes are not_found", async () => {
    const res = await booted.app.request("/api/nope");
    expect(res.status).toBe(404);
    const body = errorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("not_found");
    expect(body.request_id).toBe(res.headers.get("x-request-id") ?? "");
  });

  test("an unsupported Perch-Version is a validation error and a client request id is echoed", async () => {
    const res = await booted.app.request("/api/health", {
      headers: { "perch-version": "1999-01-01", "x-request-id": "req_abcdef123456" },
    });
    expect(res.status).toBe(422);
    const body = errorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("validation");
    expect(body.error.details?.supported).toEqual([API_VERSION]);
    expect(body.request_id).toBe("req_abcdef123456");
  });

  test("the environment loader infers modes and derives secrets", () => {
    const laptop = loadEnv({
      DATABASE_URL: "pglite://memory",
      PERCH_MASTER_KEY: booted.env.masterKey,
    });
    expect(laptop.mode).toBe("laptop");
    expect(laptop.runner.mode).toBe("inprocess");
    expect(laptop.allowLoopbackRedirects).toBe(true);
    expect(laptop.sessionSecret.length).toBeGreaterThan(20);
    expect(() => loadEnv({ DATABASE_URL: "postgres://x/y" })).toThrow(/PERCH_PUBLIC_URL/);
    expect(() =>
      loadEnv({ DATABASE_URL: "postgres://x/y", PERCH_PUBLIC_URL: "https://perch.example.test" }),
    ).toThrow(/PERCH_MASTER_KEY/);
    const team = loadEnv({
      DATABASE_URL: "postgres://x/y",
      PERCH_PUBLIC_URL: "https://perch.example.test/",
      PERCH_MASTER_KEY: booted.env.masterKey,
      PERCH_TELEMETRY: "on",
    });
    expect(team.mode).toBe("team");
    expect(team.publicUrl).toBe("https://perch.example.test");
    expect(team.runner.mode).toBe("docker");
    expect(team.telemetry).toBe(true);
    expect(team.allowLoopbackRedirects).toBe(false);
  });
});
