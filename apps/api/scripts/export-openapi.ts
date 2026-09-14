#!/usr/bin/env bun
/**
 * Writes the OpenAPI document (the source of truth, spec §7.1) to packages/api-client/openapi.json so the
 * SDKs can be generated. `bun run sdk:generate` at the root runs this and then openapi-typescript.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootTestApp } from "../src/testing.ts";

const booted = await bootTestApp();
try {
  const res = await booted.app.request("/api/openapi.json");
  const doc = (await res.json()) as Record<string, unknown>;
  // The servers entry is instance-specific; the SDK takes baseUrl at runtime.
  doc.servers = [{ url: "/" }];
  const out = resolve(import.meta.dir, "..", "..", "..", "packages", "api-client", "openapi.json");
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${out}`);
} finally {
  await booted.close();
}
