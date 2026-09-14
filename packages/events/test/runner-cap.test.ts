import { describe, expect, test } from "bun:test";
import { generateCapSecret, mintCap, verifyCap } from "../src/runner-cap.ts";

const ws = "01a09e7d-f6fc-7000-87d8-4fa256a99891";
const user = "01a09e7d-f706-7000-ae68-671ee3afeffe";

describe("runner capability tokens (spec §7.6)", () => {
  test("a minted token verifies for its workspace, user, and method while it is fresh", async () => {
    const secret = generateCapSecret();
    const token = await mintCap(secret, { ws, user, method: "fs.read", exp: 1_000 });
    expect(await verifyCap(secret, token, { ws, user, method: "fs.read" }, 999)).toEqual({
      ok: true,
      claims: { ws, user, method: "fs.read", exp: 1_000 },
    });
    expect(await verifyCap(secret, token, { ws, user, method: "fs.read" }, 1_000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("another secret, a tampered payload, and a truncated token are refused", async () => {
    const secret = generateCapSecret();
    const token = await mintCap(secret, { ws, user, method: "fs.read", exp: 5_000 });
    expect(
      (await verifyCap(generateCapSecret(), token, { ws, user, method: "fs.read" }, 1)).ok,
    ).toBe(false);
    const [payload = "", signature = ""] = token.split(".");
    const forged = `${payload.slice(0, -2)}AA.${signature}`;
    expect((await verifyCap(secret, forged, { ws, user, method: "fs.read" }, 1)).ok).toBe(false);
    expect(await verifyCap(secret, payload, { ws, user, method: "fs.read" }, 1)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyCap(secret, "not base64!.sig", { ws, user, method: "fs.read" }, 1)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("the claims must name the request: a token for one method or user is no good for another", async () => {
    const secret = generateCapSecret();
    const token = await mintCap(secret, { ws, user, method: "fs.read", exp: 5_000 });
    expect(await verifyCap(secret, token, { ws, user, method: "fs.write" }, 1)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(await verifyCap(secret, token, { ws, user: ws, method: "fs.read" }, 1)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  test("secrets are 32 random bytes in base64url", () => {
    const secret = generateCapSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateCapSecret()).not.toBe(secret);
  });
});
