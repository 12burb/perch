import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Spike 0.4.8 — Caddy wildcard (spec §9.3).
 * Pass: a DNS-challenge wildcard cert issues for *.preview.<domain>. That needs a real domain and a DNS
 * provider token, so the issuing check is check.ts run against the compose stack in this directory (CI job
 * `spikes-caddy`, gated on the CADDY_DNS_TOKEN secret). This file validates the Caddyfile whenever a caddy
 * binary is available and documents the fallback: previews run in path mode until PERCH_PREVIEW_DOMAIN
 * and CADDY_DNS_* are set (ADR-0036).
 */

const caddy = Bun.which("caddy");
const caddyfile = join(import.meta.dir, "Caddyfile");

describe("spike 0.4.8 Caddy wildcard", () => {
  test("the spike ships the Caddyfile, the DNS-module image, the compose stack, and the check script", () => {
    for (const f of ["Caddyfile", "Dockerfile.caddy", "docker-compose.yml", "check.ts"]) {
      expect(existsSync(join(import.meta.dir, f)), f).toBe(true);
    }
  });

  test.skipIf(!caddy)("caddy validate accepts the Caddyfile", () => {
    const proc = Bun.spawnSync(
      [caddy ?? "caddy", "validate", "--config", caddyfile, "--adapter", "caddyfile"],
      {
        env: {
          ...process.env,
          PERCH_PUBLIC_HOST: "perch.example.test",
          PERCH_PREVIEW_DOMAIN: "preview.example.test",
          CADDY_DNS_PROVIDER: "cloudflare",
          CADDY_DNS_TOKEN: "x",
          PERCH_ACME_EMAIL: "ops@example.test",
        },
      },
    );
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
  });
});
