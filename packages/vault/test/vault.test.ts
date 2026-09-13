import { describe, expect, test } from "bun:test";
import {
  createRotatingVault,
  createVault,
  generateMasterKey,
  parseMasterKey,
  VaultError,
} from "../src/index.ts";

describe("@perch/vault envelope encryption", () => {
  const keyA = generateMasterKey();
  const keyB = generateMasterKey();

  test("master keys are 32 random bytes, base64", () => {
    expect(parseMasterKey(keyA)).toHaveLength(32);
    expect(keyA).not.toBe(keyB);
    expect(() => parseMasterKey("dG9vc2hvcnQ=")).toThrow(VaultError);
  });

  test("round-trips strings and bytes with a fresh data key per secret", async () => {
    const vault = createVault({ masterKey: keyA });
    const a = await vault.encrypt("sk-live-abc123", "credentials:1");
    const b = await vault.encrypt("sk-live-abc123", "credentials:1");
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
    expect(await vault.decryptString(a, "credentials:1")).toBe("sk-live-abc123");
    expect(await vault.decryptString(b, "credentials:1")).toBe("sk-live-abc123");
    const bytes = new Uint8Array([0, 1, 2, 255, 254]);
    const c = await vault.encrypt(bytes);
    expect(Array.from(await vault.decrypt(c))).toEqual([0, 1, 2, 255, 254]);
    expect(vault.owns(a)).toBe(true);
    expect(vault.keyId).toHaveLength(16);
  });

  test("the wrong key, the wrong context, and a tampered byte all fail closed", async () => {
    const vault = createVault({ masterKey: keyA });
    const other = createVault({ masterKey: keyB });
    const ct = await vault.encrypt("token", "connections:42");
    await expect(other.decrypt(ct, "connections:42")).rejects.toThrow(/wrapped by key/);
    await expect(vault.decrypt(ct, "connections:43")).rejects.toThrow(VaultError);
    const tampered = new Uint8Array(ct);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
    await expect(vault.decrypt(tampered, "connections:42")).rejects.toThrow(VaultError);
    await expect(vault.decrypt(new Uint8Array([1, 2, 3]))).rejects.toThrow(/too short/);
  });

  test("rotation re-wraps the data key: the new key decrypts, the old one no longer owns it", async () => {
    const oldVault = createVault({ masterKey: keyA });
    const newVault = createVault({ masterKey: keyB });
    const ct = await oldVault.encrypt("refresh-token", "connections:7");
    const rotated = await oldVault.rewrap(ct, newVault);
    expect(newVault.owns(rotated)).toBe(true);
    expect(oldVault.owns(rotated)).toBe(false);
    expect(await newVault.decryptString(rotated, "connections:7")).toBe("refresh-token");
    await expect(oldVault.decrypt(rotated, "connections:7")).rejects.toThrow(/wrapped by key/);
    // The payload bytes are untouched by rotation.
    expect(Buffer.from(ct.subarray(ct.length - 30)).toString("hex")).toBe(
      Buffer.from(rotated.subarray(rotated.length - 30)).toString("hex"),
    );
  });

  test("a rotating vault reads old and new keys and moves ciphertexts to the current key", async () => {
    const oldVault = createVault({ masterKey: keyA });
    const ct = await oldVault.encrypt("secret", "x");
    const rotating = createRotatingVault([keyB, keyA]);
    expect(rotating.keyId).toBe(createVault({ masterKey: keyB }).keyId);
    expect(await rotating.decryptString(ct, "x")).toBe("secret");
    const moved = await rotating.rewrapToCurrent(ct);
    expect(createVault({ masterKey: keyB }).owns(moved)).toBe(true);
    expect(await rotating.decryptString(moved, "x")).toBe("secret");
    expect(() => createRotatingVault([])).toThrow(VaultError);
  });
});
