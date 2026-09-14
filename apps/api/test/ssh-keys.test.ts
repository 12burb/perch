import { describe, expect, test } from "bun:test";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeOpenSshPrivateKey,
  fingerprintOf,
  generateDeployKey,
  generateEd25519,
  parsePublicKeyLine,
  publicKeyBlob,
} from "../src/services/ssh-keys.ts";

/**
 * Task 1.4: deploy keys are real OpenSSH Ed25519 keys. The public line parses back to the key,
 * the private file decodes to the same seed (and signs for the public key), the fingerprint matches
 * ssh-keygen's formula, and, where ssh-keygen exists, it accepts the file and derives the same line.
 */

function readString(buf: Buffer, offset: number): { value: Buffer; next: number } {
  const length = buf.readUInt32BE(offset);
  return { value: buf.subarray(offset + 4, offset + 4 + length), next: offset + 4 + length };
}

function decodePrivate(pem: string) {
  const base64 = pem
    .split("\n")
    .filter((line) => line && !line.startsWith("-----"))
    .join("");
  const buf = Buffer.from(base64, "base64");
  const magic = "openssh-key-v1\0";
  expect(buf.subarray(0, magic.length).toString("binary")).toBe(magic);
  let at = magic.length;
  const cipher = readString(buf, at);
  at = cipher.next;
  const kdf = readString(buf, at);
  at = kdf.next;
  const kdfOptions = readString(buf, at);
  at = kdfOptions.next;
  const count = buf.readUInt32BE(at);
  at += 4;
  const publicBlob = readString(buf, at);
  at = publicBlob.next;
  const privateSection = readString(buf, at);
  expect(privateSection.next).toBe(buf.length);
  const priv = privateSection.value;
  const check1 = priv.readUInt32BE(0);
  const check2 = priv.readUInt32BE(4);
  let p = 8;
  const type = readString(priv, p);
  p = type.next;
  const pub = readString(priv, p);
  p = pub.next;
  const secret = readString(priv, p);
  p = secret.next;
  const comment = readString(priv, p);
  p = comment.next;
  const padding = priv.subarray(p);
  return {
    cipher: cipher.value.toString(),
    kdf: kdf.value.toString(),
    kdfOptions: kdfOptions.value,
    count,
    publicBlob: publicBlob.value,
    check1,
    check2,
    type: type.value.toString(),
    pub: pub.value,
    secret: secret.value,
    comment: comment.value.toString(),
    padding,
  };
}

describe("deploy keys (task 1.4)", () => {
  test("the public line, the private file, and the fingerprint agree", () => {
    const key = generateDeployKey("perch-test");
    const line = parsePublicKeyLine(key.publicKey);
    expect(line.type).toBe("ssh-ed25519");
    expect(line.comment).toBe("perch-test");
    const blobType = readString(line.blob, 0);
    expect(blobType.value.toString()).toBe("ssh-ed25519");
    const publicKey = readString(line.blob, blobType.next).value;
    expect(publicKey.length).toBe(32);

    const decoded = decodePrivate(key.privateKey);
    expect(decoded.cipher).toBe("none");
    expect(decoded.kdf).toBe("none");
    expect(decoded.kdfOptions.length).toBe(0);
    expect(decoded.count).toBe(1);
    expect(decoded.publicBlob.equals(line.blob)).toBe(true);
    expect(decoded.check1).toBe(decoded.check2);
    expect(decoded.type).toBe("ssh-ed25519");
    expect(decoded.pub.equals(publicKey)).toBe(true);
    expect(decoded.secret.length).toBe(64);
    expect(decoded.secret.subarray(32).equals(publicKey)).toBe(true);
    expect(decoded.comment).toBe("perch-test");
    expect([...decoded.padding]).toEqual(Array.from(decoded.padding, (_, i) => i + 1));

    // The seed signs for the public key (node:crypto round trip through PKCS8/SPKI).
    const seed = decoded.secret.subarray(0, 32);
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]);
    const message = Buffer.from("perch");
    const signature = sign(
      null,
      message,
      createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }),
    );
    expect(
      verify(null, message, createPublicKey({ key: spki, format: "der", type: "spki" }), signature),
    ).toBe(true);

    const digest = createHash("sha256").update(line.blob).digest("base64").replace(/=+$/, "");
    expect(key.fingerprint).toBe(`SHA256:${digest}`);
    expect(fingerprintOf(publicKeyBlob(publicKey))).toBe(key.fingerprint);
  });

  test("the encoding is deterministic for a given seed and check value", () => {
    const { seed, publicKey } = generateEd25519();
    const a = encodeOpenSshPrivateKey(seed, publicKey, "c", 7);
    const b = encodeOpenSshPrivateKey(seed, publicKey, "c", 7);
    expect(a).toBe(b);
    expect(a.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe(true);
    expect(a.endsWith("\n-----END OPENSSH PRIVATE KEY-----\n")).toBe(true);
    for (const line of a.split("\n").slice(1, -2)) expect(line.length).toBeLessThanOrEqual(70);
  });

  test("ssh-keygen accepts the private file and derives the same public line", async () => {
    const which = Bun.spawnSync(["sh", "-c", "command -v ssh-keygen"]);
    if (which.exitCode !== 0) return; // not installed here; the format test above still holds
    const key = generateDeployKey("perch-keygen");
    const dir = mkdtempSync(join(tmpdir(), "perch-sshkey-"));
    try {
      const file = join(dir, "id");
      writeFileSync(file, key.privateKey, { mode: 0o600 });
      const derived = Bun.spawnSync(["ssh-keygen", "-y", "-f", file]);
      expect(derived.exitCode).toBe(0);
      // ssh-keygen -y prints the comment stored in the private file too: the whole line matches.
      expect(derived.stdout.toString().trim()).toBe(key.publicKey);
      const listed = Bun.spawnSync(["ssh-keygen", "-l", "-f", file]);
      expect(listed.stdout.toString()).toContain(key.fingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
