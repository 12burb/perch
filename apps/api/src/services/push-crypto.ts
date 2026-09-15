/**
 * Web Push, the parts that are cryptography (task 2.3): message encryption per RFC 8291 with the
 * `aes128gcm` content encoding of RFC 8188, and the VAPID identification of RFC 8292.
 *
 * Perch ships this itself rather than taking a dependency: it is a hundred lines of WebCrypto, it
 * has no network of its own, and a push service is the one place a self-hosted Perch talks to the
 * outside on a user's behalf — the less of that is somebody else's code, the better.
 *
 * Nothing here logs. The subscription's keys are the reader's, and the payload is what they will be
 * told; neither belongs in a log line (AGENTS §1.6).
 */

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
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

/** HKDF as RFC 5869, in the one shape web push uses: one block of output, at most 32 bytes. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  const block = await hmac(prk, concat(info, Uint8Array.of(1)));
  return block.subarray(0, length);
}

/**
 * The labels of RFC 8291 §3.4 and RFC 8188 §2.2, each terminated by a zero byte. The counter byte
 * HKDF-Expand ends with is added by `hkdf`, so it is not part of these.
 */
const KEY_LABEL = concat(encoder.encode("WebPush: info"), Uint8Array.of(0));
const CEK_INFO = concat(encoder.encode("Content-Encoding: aes128gcm"), Uint8Array.of(0));
const NONCE_INFO = concat(encoder.encode("Content-Encoding: nonce"), Uint8Array.of(0));

/** One record, which is all Perch sends: a notification is far smaller than the 4096-byte default. */
const RECORD_SIZE = 4096;

export type Subscription = {
  endpoint: string;
  /** The receiver's public key, an uncompressed P-256 point, base64url. */
  p256dh: string;
  /** The 16-byte shared authentication secret, base64url. */
  auth: string;
};

/**
 * The encrypted body of a push message (RFC 8291 §3.4, RFC 8188 §2): a header carrying the salt,
 * the record size and the sender's public key, then one AES-128-GCM record.
 */
export async function encryptPush(
  payload: Uint8Array,
  subscription: Pick<Subscription, "p256dh" | "auth">,
  options: { salt?: Uint8Array; senderKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array> {
  const receiverPublic = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);
  const sender =
    options.senderKeys ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey));
  const receiverKey = await crypto.subtle.importKey(
    "raw",
    receiverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, sender.privateKey, 256),
  );

  // The "input keying material" binds the two public keys to the subscription's own secret, so a
  // push service that sees the body learns nothing it could replay to another subscription.
  const ikm = await hkdf(authSecret, shared, concat(KEY_LABEL, receiverPublic, senderPublic), 32);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = await hkdf(salt, ikm, NONCE_INFO, 12);

  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  // 0x02 ends the last record; there is only ever one here.
  const record = concat(payload, Uint8Array.of(2));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, record),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE, false);
  return concat(salt, recordSize, Uint8Array.of(senderPublic.length), senderPublic, ciphertext);
}

export type VapidKeys = {
  /** The uncompressed P-256 point, base64url — what a browser is handed to subscribe with. */
  publicKey: string;
  /** The private scalar, base64url. Never leaves the instance. */
  privateKey: string;
};

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: base64UrlEncode(raw), privateKey: jwk.d ?? "" };
}

/** The signing key, rebuilt from the stored scalar and the public point it belongs to. */
async function signingKey(keys: VapidKeys): Promise<CryptoKey> {
  const raw = base64UrlDecode(keys.publicKey);
  if (raw.length !== 65 || raw[0] !== 4)
    throw new Error("the VAPID public key is not a P-256 point");
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: base64UrlEncode(raw.subarray(1, 33)),
      y: base64UrlEncode(raw.subarray(33, 65)),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** Who a push service is talking to: the origin of the endpoint, per RFC 8292 §2. */
export function audienceOf(endpoint: string): string {
  return new URL(endpoint).origin;
}

/**
 * The `Authorization: vapid …` header of RFC 8292: a JWT saying which instance is asking, signed
 * with the key the subscription was made against, valid for hours rather than for ever.
 */
export async function vapidAuthorization(
  keys: VapidKeys,
  input: { endpoint: string; subject: string; now?: number; ttlSeconds?: number },
): Promise<string> {
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        aud: audienceOf(input.endpoint),
        exp: now + (input.ttlSeconds ?? 12 * 60 * 60),
        sub: input.subject,
      }),
    ),
  );
  const signed = `${header}.${claims}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      await signingKey(keys),
      encoder.encode(signed),
    ),
  );
  return `vapid t=${signed}.${base64UrlEncode(signature)}, k=${keys.publicKey}`;
}
