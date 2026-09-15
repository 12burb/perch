import { describe, expect, test } from "bun:test";
import { mintToolToken, TOOL_TOKEN_MS, verifyToolToken } from "../src/services/mcp.ts";

/**
 * Task 1.17 (spec §7.5, AGENTS.md §1.6): the token a session carries to the MCP gateway. It is
 * Perch's own — the point of it is that an agent holds this and never a provider's credential — so
 * what it will and will not accept is worth pinning down.
 */

const SECRET = "a-test-signing-secret";
const claims = { ws: "w1", user: "u1", session: "s1", exp: Date.now() + TOOL_TOKEN_MS };

describe("the gateway's session token", () => {
  test("round-trips its claims, and says who it was minted for", async () => {
    const token = await mintToolToken(SECRET, claims);
    const verified = await verifyToolToken(SECRET, token);
    expect(verified).toMatchObject({ ws: "w1", user: "u1", session: "s1" });
  });

  test("another secret cannot mint one Perch will accept", async () => {
    const token = await mintToolToken("some-other-secret", claims);
    expect(await verifyToolToken(SECRET, token)).toBeNull();
  });

  test("a tampered payload is refused, even though its own signature is intact", async () => {
    const token = await mintToolToken(SECRET, claims);
    const [payload, signature] = token.split(".");
    // Re-encoding the claims with a different session keeps the shape and breaks the signature.
    const forged = btoa(JSON.stringify({ ...claims, session: "someone-elses" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyToolToken(SECRET, `${forged}.${signature}`)).toBeNull();
    expect(payload).not.toBe(forged);
  });

  test("an expired token is no token at all", async () => {
    const token = await mintToolToken(SECRET, { ...claims, exp: Date.now() - 1 });
    expect(await verifyToolToken(SECRET, token)).toBeNull();
    // And one that is still good now is refused once its moment passes.
    const short = await mintToolToken(SECRET, { ...claims, exp: Date.now() + 50 });
    expect(await verifyToolToken(SECRET, short)).not.toBeNull();
    expect(await verifyToolToken(SECRET, short, Date.now() + 100)).toBeNull();
  });

  test("nonsense is refused rather than crashing", async () => {
    for (const bad of ["", ".", "no-dot", "a.b", `${btoa("{}")}.zz`]) {
      expect(await verifyToolToken(SECRET, bad)).toBeNull();
    }
  });
});
