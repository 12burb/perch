import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Spike 0.4.10 — cloudflared profile (spec §9.3).
 * Pass: an OAuth callback and a webhook reach the api through the tunnel. That needs a Cloudflare account
 * and a tunnel token, so the live check is check.ts against the compose stack in this directory (CI job
 * `spikes-cloudflared`, gated on the TUNNEL_TOKEN secret). Fallback documented in README.md: Tailscale
 * Serve or Funnel. Outcome in DECISIONS.md (ADR-0038).
 */
describe("spike 0.4.10 cloudflared profile", () => {
  test("the spike ships the compose profile, the check script, and the Tailscale fallback notes", () => {
    for (const f of ["docker-compose.yml", "check.ts", "README.md"]) {
      expect(existsSync(join(import.meta.dir, f)), f).toBe(true);
    }
  });
});
