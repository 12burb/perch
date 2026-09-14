/**
 * Ed25519 deploy keys in OpenSSH's own formats (spec §5.1: a per-workspace SSH deploy key), from
 * node:crypto: the public line people paste into a repository's deploy keys, the private key file git
 * reads through `ssh -i`, and the `SHA256:` fingerprint ssh-keygen -l prints. No shelling out, so a
 * hosted api without ssh-keygen mints keys too.
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

export type DeployKeyPair = {
  /** `ssh-ed25519 <base64 blob> <comment>` */
  publicKey: string;
  /** `-----BEGIN OPENSSH PRIVATE KEY-----…` (unencrypted; the vault wraps it at rest) */
  privateKey: string;
  /** `SHA256:<base64 without padding>` over the public key blob */
  fingerprint: string;
};

const KEY_TYPE = "ssh-ed25519";

function sshString(bytes: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function sshText(text: string): Buffer {
  return sshString(Buffer.from(text, "utf8"));
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

/** The public key blob: string "ssh-ed25519", string <32-byte key>. */
export function publicKeyBlob(publicKey: Uint8Array): Buffer {
  return Buffer.concat([sshText(KEY_TYPE), sshString(publicKey)]);
}

export function fingerprintOf(blob: Uint8Array): string {
  const digest = createHash("sha256").update(blob).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/**
 * The openssh-key-v1 container with one unencrypted key (PROTOCOL.key in the OpenSSH sources):
 * magic, cipher "none", kdf "none", empty kdf options, one public blob, then the private section
 * (two equal check ints, the key type, public key, 64-byte private key = seed || public, comment,
 * padding 1..n up to the 8-byte block).
 */
export function encodeOpenSshPrivateKey(
  seed: Uint8Array,
  publicKey: Uint8Array,
  comment: string,
  check: number = randomBytes(4).readUInt32BE(),
): string {
  const privateSection = Buffer.concat([
    uint32(check),
    uint32(check),
    sshText(KEY_TYPE),
    sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])),
    sshText(comment),
  ]);
  const padLength = (8 - (privateSection.length % 8)) % 8;
  const padding = Buffer.from(Array.from({ length: padLength }, (_, i) => i + 1));
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshText("none"),
    sshText("none"),
    sshText(""),
    uint32(1),
    sshString(publicKeyBlob(publicKey)),
    sshString(Buffer.concat([privateSection, padding])),
  ]);
  const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

export function encodeOpenSshPublicKey(publicKey: Uint8Array, comment: string): string {
  return `${KEY_TYPE} ${publicKeyBlob(publicKey).toString("base64")} ${comment}`;
}

/** Ed25519 raw material out of node:crypto's DER exports: the last 32 bytes of each. */
export function generateEd25519(): { seed: Uint8Array; publicKey: Uint8Array } {
  const pair = generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  const pkcs8 = pair.privateKey.export({ format: "der", type: "pkcs8" });
  return {
    publicKey: new Uint8Array(spki.subarray(spki.length - 32)),
    seed: new Uint8Array(pkcs8.subarray(pkcs8.length - 32)),
  };
}

export function generateDeployKey(comment: string): DeployKeyPair {
  const { seed, publicKey } = generateEd25519();
  return {
    publicKey: encodeOpenSshPublicKey(publicKey, comment),
    privateKey: encodeOpenSshPrivateKey(seed, publicKey, comment),
    fingerprint: fingerprintOf(publicKeyBlob(publicKey)),
  };
}

/** Reads the blob back out of a public key line (tests, and fingerprints of pasted keys). */
export function parsePublicKeyLine(line: string): { type: string; blob: Buffer; comment: string } {
  const [type, base64, ...rest] = line.trim().split(/\s+/);
  if (!type || !base64) throw new Error("not an OpenSSH public key line");
  return { type, blob: Buffer.from(base64, "base64"), comment: rest.join(" ") };
}
