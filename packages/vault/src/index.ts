/**
 * @perch/vault: envelope encryption for every stored secret (spec §2). AES-256-GCM through WebCrypto; a
 * per-secret data key (DEK) is wrapped by the root key (KEK) from PERCH_MASTER_KEY. Rotation re-wraps DEKs
 * without touching payloads. KMS and age providers land behind the same `Vault` interface later.
 *
 * Wire format (bytes):
 *   "PV" | version(1) | keyId(8) | wrappedDek(12 iv + 32 key + 16 tag) | iv(12) | ciphertext+tag
 */

import type { webcrypto } from "node:crypto";

export interface Vault {
  /** Identifies the root key that wrapped a ciphertext's data key (first 8 bytes of sha256(KEK)). */
  readonly keyId: string;
  encrypt(plaintext: Uint8Array | string, aad?: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, aad?: string): Promise<Uint8Array>;
  decryptString(ciphertext: Uint8Array, aad?: string): Promise<string>;
  /** Re-wraps the data key with `next`'s root key; the payload is not re-encrypted. */
  rewrap(ciphertext: Uint8Array, next: Vault): Promise<Uint8Array>;
  /** Whether this vault's root key wrapped the ciphertext. */
  owns(ciphertext: Uint8Array): boolean;
}

const MAGIC = new TextEncoder().encode("PV");
const VERSION = 1;
const KEY_ID_BYTES = 8;
const IV_BYTES = 12;
const DEK_BYTES = 32;
const TAG_BYTES = 16;
const WRAPPED_DEK_BYTES = IV_BYTES + DEK_BYTES + TAG_BYTES;
const HEADER_BYTES = MAGIC.length + 1 + KEY_ID_BYTES + WRAPPED_DEK_BYTES + IV_BYTES;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A new 32-byte root key, base64 (what `perch init` writes into PERCH_MASTER_KEY). */
export function generateMasterKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

export function parseMasterKey(masterKey: string): Uint8Array {
  const bytes = Buffer.from(masterKey.trim(), "base64");
  if (bytes.length !== 32) {
    throw new VaultError(
      "PERCH_MASTER_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)",
    );
  }
  return new Uint8Array(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function importAesKey(raw: Uint8Array, usages: webcrypto.KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
}

async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const params: webcrypto.AesGcmParams = {
    name: "AES-GCM",
    iv,
    ...(aad ? { additionalData: aad } : {}),
  };
  const ct = new Uint8Array(await crypto.subtle.encrypt(params, key, plaintext));
  return concat(iv, ct);
}

async function aesGcmDecrypt(
  key: CryptoKey,
  ivAndCiphertext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const iv = ivAndCiphertext.subarray(0, IV_BYTES);
  const ct = ivAndCiphertext.subarray(IV_BYTES);
  const params: webcrypto.AesGcmParams = {
    name: "AES-GCM",
    iv,
    ...(aad ? { additionalData: aad } : {}),
  };
  try {
    return new Uint8Array(await crypto.subtle.decrypt(params, key, ct));
  } catch {
    throw new VaultError("decryption failed: wrong key, wrong context, or tampered ciphertext");
  }
}

type Parsed = { keyId: string; wrappedDek: Uint8Array; body: Uint8Array };

function parseEnvelope(ciphertext: Uint8Array): Parsed {
  if (ciphertext.length < HEADER_BYTES + TAG_BYTES) throw new VaultError("ciphertext too short");
  if (ciphertext[0] !== MAGIC[0] || ciphertext[1] !== MAGIC[1])
    throw new VaultError("not a vault ciphertext");
  if (ciphertext[2] !== VERSION)
    throw new VaultError(`unsupported vault format version ${ciphertext[2]}`);
  let offset = 3;
  const keyId = toHex(ciphertext.subarray(offset, offset + KEY_ID_BYTES));
  offset += KEY_ID_BYTES;
  const wrappedDek = ciphertext.subarray(offset, offset + WRAPPED_DEK_BYTES);
  offset += WRAPPED_DEK_BYTES;
  const body = ciphertext.subarray(offset);
  return { keyId, wrappedDek, body };
}

class LocalVault implements Vault {
  readonly keyId: string;
  private readonly keyIdBytes: Uint8Array;
  private readonly kek: Promise<CryptoKey>;

  constructor(masterKey: Uint8Array) {
    this.keyIdBytes = new Uint8Array(
      new Bun.CryptoHasher("sha256").update(masterKey).digest().subarray(0, KEY_ID_BYTES),
    );
    this.keyId = toHex(this.keyIdBytes);
    this.kek = importAesKey(masterKey, ["encrypt", "decrypt"]);
  }

  async encrypt(plaintext: Uint8Array | string, aad?: string): Promise<Uint8Array> {
    const data = typeof plaintext === "string" ? encoder.encode(plaintext) : plaintext;
    const dekRaw = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const dek = await importAesKey(dekRaw, ["encrypt"]);
    const body = await aesGcmEncrypt(dek, data, aad ? encoder.encode(aad) : undefined);
    const wrappedDek = await aesGcmEncrypt(await this.kek, dekRaw, this.keyIdBytes);
    return concat(MAGIC, new Uint8Array([VERSION]), this.keyIdBytes, wrappedDek, body);
  }

  async decrypt(ciphertext: Uint8Array, aad?: string): Promise<Uint8Array> {
    const dekRaw = await this.unwrap(ciphertext);
    const dek = await importAesKey(dekRaw, ["decrypt"]);
    return aesGcmDecrypt(
      dek,
      parseEnvelope(ciphertext).body,
      aad ? encoder.encode(aad) : undefined,
    );
  }

  async decryptString(ciphertext: Uint8Array, aad?: string): Promise<string> {
    return decoder.decode(await this.decrypt(ciphertext, aad));
  }

  async rewrap(ciphertext: Uint8Array, next: Vault): Promise<Uint8Array> {
    if (!(next instanceof LocalVault)) throw new VaultError("rewrap target must be a local vault");
    const dekRaw = await this.unwrap(ciphertext);
    const { body } = parseEnvelope(ciphertext);
    const wrappedDek = await aesGcmEncrypt(await next.kek, dekRaw, next.keyIdBytes);
    return concat(MAGIC, new Uint8Array([VERSION]), next.keyIdBytes, wrappedDek, body);
  }

  owns(ciphertext: Uint8Array): boolean {
    try {
      return parseEnvelope(ciphertext).keyId === this.keyId;
    } catch {
      return false;
    }
  }

  private async unwrap(ciphertext: Uint8Array): Promise<Uint8Array> {
    const parsed = parseEnvelope(ciphertext);
    if (parsed.keyId !== this.keyId) {
      throw new VaultError(
        `ciphertext was wrapped by key ${parsed.keyId}, this vault is ${this.keyId}`,
      );
    }
    return aesGcmDecrypt(await this.kek, parsed.wrappedDek, this.keyIdBytes);
  }
}

export type CreateVaultOptions = {
  /** Base64 32-byte root key (PERCH_MASTER_KEY). */
  masterKey: string;
};

export function createVault(options: CreateVaultOptions): Vault {
  return new LocalVault(parseMasterKey(options.masterKey));
}

/**
 * A vault that decrypts with any of several root keys (during rotation) and encrypts with the first.
 * `rewrapAll` moves a ciphertext to the current key.
 */
export function createRotatingVault(
  masterKeys: string[],
): Vault & { rewrapToCurrent: (c: Uint8Array) => Promise<Uint8Array> } {
  const vaults = masterKeys.map((k) => createVault({ masterKey: k }));
  const current = vaults[0];
  if (!current) throw new VaultError("at least one master key is required");
  const owner = (c: Uint8Array) => vaults.find((v) => v.owns(c)) ?? current;
  return {
    keyId: current.keyId,
    encrypt: (p, aad) => current.encrypt(p, aad),
    decrypt: (c, aad) => owner(c).decrypt(c, aad),
    decryptString: (c, aad) => owner(c).decryptString(c, aad),
    rewrap: (c, next) => owner(c).rewrap(c, next),
    owns: (c) => vaults.some((v) => v.owns(c)),
    rewrapToCurrent: (c) => (current.owns(c) ? Promise.resolve(c) : owner(c).rewrap(c, current)),
  };
}
