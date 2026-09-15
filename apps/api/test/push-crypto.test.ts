import { describe, expect, test } from "bun:test";
import {
  audienceOf,
  base64UrlDecode,
  base64UrlEncode,
  encryptPush,
  generateVapidKeys,
  vapidAuthorization,
} from "../src/services/push-crypto.ts";
import { decryptPush, subscribeAsBrowser } from "./fixtures/push.ts";

/**
 * Task 2.3: the cryptography under web push — RFC 8291 message encryption in the `aes128gcm`
 * encoding of RFC 8188, and the VAPID identification of RFC 8292.
 *
 * The test is the other half of the protocol: `fixtures/push.ts` plays the browser, making a
 * subscription the way a user agent does and decrypting what Perch would POST the way the receiving
 * side is specified to. Nothing is shared between the two sides except what crosses the wire.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("web push cryptography (task 2.3)", () => {
  test("base64url round-trips, without padding", () => {
    const bytes = Uint8Array.from([0, 251, 255, 1, 2, 3]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect([...base64UrlDecode(encoded)]).toEqual([...bytes]);
  });

  test("a message Perch encrypts is one the browser can read", async () => {
    const ua = await subscribeAsBrowser();
    const said = JSON.stringify({ title: "Wren", body: "over to you", url: "/nest/home/general" });
    const body = await encryptPush(encoder.encode(said), ua.subscription);

    // The header is what RFC 8188 says it is: salt, record size, key length, key.
    expect(body.length).toBeGreaterThan(21 + 65);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16, false)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(4);

    expect(await decryptPush(body, ua)).toBe(said);
  }, 30_000);

  test("every message is encrypted to its own subscription", async () => {
    const wren = await subscribeAsBrowser();
    const robin = await subscribeAsBrowser();
    const body = await encryptPush(encoder.encode("for Wren only"), wren.subscription);
    expect(await decryptPush(body, wren)).toBe("for Wren only");
    // Robin's key is not Wren's: the same body decrypts to nothing at all.
    await expect(decryptPush(body, robin)).rejects.toThrow();
  }, 30_000);

  test("the same message twice is two different bodies", async () => {
    const ua = await subscribeAsBrowser();
    const first = await encryptPush(encoder.encode("same words"), ua.subscription);
    const second = await encryptPush(encoder.encode("same words"), ua.subscription);
    expect(base64UrlEncode(first)).not.toBe(base64UrlEncode(second));
    expect(await decryptPush(first, ua)).toBe("same words");
    expect(await decryptPush(second, ua)).toBe("same words");
  }, 30_000);

  test("VAPID: a signed JWT for the endpoint's origin, and the key beside it", async () => {
    const keys = await generateVapidKeys();
    const endpoint = "https://push.example.test/v2/abcdef?token=1";
    expect(audienceOf(endpoint)).toBe("https://push.example.test");

    const header = await vapidAuthorization(keys, {
      endpoint,
      subject: "mailto:nest@perch.test",
      now: 1_700_000_000_000,
    });
    const match = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, jwt = "", key = ""] = match ?? [];
    expect(key).toBe(keys.publicKey);

    const [encodedHeader = "", encodedClaims = "", encodedSignature = ""] = jwt.split(".");
    expect(JSON.parse(decoder.decode(base64UrlDecode(encodedHeader)))).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    const claims = JSON.parse(decoder.decode(base64UrlDecode(encodedClaims))) as {
      aud: string;
      exp: number;
      sub: string;
    };
    expect(claims.aud).toBe("https://push.example.test");
    expect(claims.sub).toBe("mailto:nest@perch.test");
    expect(claims.exp).toBe(1_700_000_000 + 12 * 60 * 60);

    // The signature verifies against the public key the header advertises, which is the whole
    // point of VAPID: a push service can tell one sender from another.
    const raw = base64UrlDecode(key);
    const verifier = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: base64UrlEncode(raw.subarray(1, 33)),
        y: base64UrlEncode(raw.subarray(33, 65)),
        ext: true,
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifier,
      base64UrlDecode(encodedSignature),
      encoder.encode(`${encodedHeader}.${encodedClaims}`),
    );
    expect(ok).toBe(true);
  }, 30_000);
});
