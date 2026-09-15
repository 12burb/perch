/**
 * The browser's half of web push, for tests (task 2.3): a subscription made the way a user agent
 * makes one, and the receiving side of RFC 8291 written from the specification rather than shared
 * with the code under test.
 */
import { base64UrlEncode } from "../../src/services/push-crypto.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data));
}

async function expand(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, Uint8Array.of(1)))).subarray(0, length);
}

export type UserAgent = {
  keys: CryptoKeyPair;
  /** What `pushManager.subscribe()` hands the application: the two keys, base64url. */
  subscription: { p256dh: string; auth: string };
  raw: { p256dh: Uint8Array; auth: Uint8Array };
};

export async function subscribeAsBrowser(): Promise<UserAgent> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const p256dh = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys,
    subscription: { p256dh: base64UrlEncode(p256dh), auth: base64UrlEncode(auth) },
    raw: { p256dh, auth },
  };
}

/** What the browser would hand the service worker: the plaintext of one push message. */
export async function decryptPush(body: Uint8Array, ua: UserAgent): Promise<string> {
  const salt = body.subarray(0, 16);
  const keyLength = body[20] ?? 0;
  const senderPublic = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);

  const senderKey = await crypto.subtle.importKey(
    "raw",
    senderPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, ua.keys.privateKey, 256),
  );
  const ikm = await expand(
    ua.raw.auth,
    shared,
    concat(encoder.encode("WebPush: info"), Uint8Array.of(0), ua.raw.p256dh, senderPublic),
    32,
  );
  const cek = await expand(
    salt,
    ikm,
    concat(encoder.encode("Content-Encoding: aes128gcm"), Uint8Array.of(0)),
    16,
  );
  const nonce = await expand(
    salt,
    ikm,
    concat(encoder.encode("Content-Encoding: nonce"), Uint8Array.of(0)),
    12,
  );
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, ciphertext),
  );
  // The last byte is the record delimiter, 0x02.
  return decoder.decode(plain.subarray(0, -1));
}
