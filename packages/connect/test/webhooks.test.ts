import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "../src/manifest.ts";
import { ed25519Keypair, signDelivery, verifyDelivery, webhookSecret } from "../src/webhooks.ts";

/**
 * Task 3.4 (spec §3.5): whether a delivery is really from the provider. The signatures here are
 * made the way each provider makes them, against the manifests Perch ships, so a connector that
 * describes its scheme wrongly fails here rather than in production.
 */

const root = join(import.meta.dir, "..", "..", "..", "connectors");

function manifest(id: string) {
  return parseManifest(readFileSync(join(root, id, "manifest.yaml"), "utf8"));
}

async function hmac(secret: string, body: string, encoding: "hex" | "base64"): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return encoding === "base64"
    ? btoa(String.fromCharCode(...mac))
    : [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const SECRET = "a-secret-somebody-pasted";
const BODY = JSON.stringify({ ref: "refs/heads/main", commits: [{ id: "abc" }] });

describe("a GitHub delivery", () => {
  test("is taken when it is signed with this instance's secret", async () => {
    const github = manifest("github");
    const verdict = await verifyDelivery({
      manifest: github,
      headers: {
        "X-Hub-Signature-256": `sha256=${await hmac(SECRET, BODY, "hex")}`,
        "X-GitHub-Delivery": "d-1",
        "X-GitHub-Event": "push",
      },
      body: BODY,
      secret: SECRET,
    });
    expect(verdict).toEqual({ ok: true, delivery: { id: "d-1", event: "push" } });
  });

  test("is refused when it is signed with somebody else's, or not at all", async () => {
    const github = manifest("github");
    const wrong = await verifyDelivery({
      manifest: github,
      headers: { "x-hub-signature-256": `sha256=${await hmac("not-it", BODY, "hex")}` },
      body: BODY,
      secret: SECRET,
    });
    expect(wrong).toEqual({ ok: false, reason: "that signature is not this instance's" });

    const bare = await verifyDelivery({
      manifest: github,
      headers: {},
      body: BODY,
      secret: SECRET,
    });
    expect(bare.ok).toBe(false);
  });

  test("is refused when the body is not the one that was signed", async () => {
    const github = manifest("github");
    const verdict = await verifyDelivery({
      manifest: github,
      headers: { "x-hub-signature-256": `sha256=${await hmac(SECRET, BODY, "hex")}` },
      body: `${BODY} `,
      secret: SECRET,
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("a Vercel delivery", () => {
  test("is a bare hex signature over the body", async () => {
    const vercel = manifest("vercel");
    const verdict = await verifyDelivery({
      manifest: vercel,
      headers: {
        "x-vercel-signature": await hmac(SECRET, BODY, "hex"),
        "x-vercel-id": "v-1",
        "x-vercel-event": "deployment.succeeded",
      },
      body: BODY,
      secret: SECRET,
    });
    expect(verdict).toEqual({
      ok: true,
      delivery: { id: "v-1", event: "deployment.succeeded" },
    });
  });
});

describe("a Clerk delivery", () => {
  const svix = async (at: number) => {
    const clerk = manifest("clerk");
    const timestamp = String(Math.floor(at / 1000));
    const signature = await hmac(SECRET, `msg_1.${timestamp}.${BODY}`, "base64");
    return {
      clerk,
      headers: {
        "svix-id": "msg_1",
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${signature}`,
        "svix-event-type": "user.created",
      },
    };
  };

  test("signs the id, the time and the body together", async () => {
    const now = Date.now();
    const { clerk, headers } = await svix(now);
    const verdict = await verifyDelivery({
      manifest: clerk,
      headers,
      body: BODY,
      secret: SECRET,
      now,
    });
    expect(verdict).toEqual({ ok: true, delivery: { id: "msg_1", event: "user.created" } });
  });

  test("is refused when it was signed too long ago to be a live delivery", async () => {
    const now = Date.now();
    const { clerk, headers } = await svix(now - 40 * 60 * 1000);
    const verdict = await verifyDelivery({
      manifest: clerk,
      headers,
      body: BODY,
      secret: SECRET,
      now,
    });
    expect(verdict).toEqual({ ok: false, reason: "that delivery is too old" });
  });

  test("takes any of the signatures offered, so a secret can be rotated", async () => {
    const now = Date.now();
    const { clerk, headers } = await svix(now);
    const verdict = await verifyDelivery({
      manifest: clerk,
      headers: { ...headers, "svix-signature": `v1,not-it ${headers["svix-signature"].slice(3)}` },
      body: BODY,
      secret: SECRET,
      now,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("a provider that signs nothing", () => {
  test("is taken, because there is nothing to check", async () => {
    const supabase = manifest("supabase");
    const verdict = await verifyDelivery({
      manifest: supabase,
      headers: {},
      body: BODY,
      secret: SECRET,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("a Discord delivery (task 3.25)", () => {
  /** What Discord does: sign `<timestamp><body>` with the application's own private key. */
  async function sign(privateKey: string, timestamp: string, body: string): Promise<string> {
    return await signDelivery({
      manifest: manifest("discord"),
      headers: { "x-signature-timestamp": timestamp },
      body,
      secret: privateKey,
    });
  }

  test("is taken when it carries this application's Ed25519 signature", async () => {
    const discord = manifest("discord");
    const keys = await ed25519Keypair();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const verdict = await verifyDelivery({
      manifest: discord,
      headers: {
        "x-signature-ed25519": await sign(keys.privateKey, timestamp, BODY),
        "x-signature-timestamp": timestamp,
      },
      body: BODY,
      // The key Perch holds is the public half: it can check a signature and never make one.
      secret: keys.publicKey,
    });
    expect(verdict.ok).toBe(true);
  });

  test("is refused when it is signed by another application, or over another body", async () => {
    const discord = manifest("discord");
    const keys = await ed25519Keypair();
    const somebodyElse = await ed25519Keypair();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(keys.privateKey, timestamp, BODY);

    const wrongKey = await verifyDelivery({
      manifest: discord,
      headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
      body: BODY,
      secret: somebodyElse.publicKey,
    });
    expect(wrongKey).toMatchObject({ ok: false });

    const wrongBody = await verifyDelivery({
      manifest: discord,
      headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
      body: `${BODY} `,
      secret: keys.publicKey,
    });
    expect(wrongBody).toMatchObject({ ok: false });

    // The timestamp is signed, so moving it invalidates the signature — and it is checked for age
    // first, which is what stops a delivery being replayed tomorrow.
    const old = String(Math.floor(Date.now() / 1000) - 3_600);
    const replayed = await verifyDelivery({
      manifest: discord,
      headers: { "x-signature-ed25519": signature, "x-signature-timestamp": old },
      body: BODY,
      secret: keys.publicKey,
    });
    expect(replayed).toMatchObject({ ok: false, reason: "that delivery is too old" });
  });

  test("is refused when this endpoint's key is not a key", async () => {
    const verdict = await verifyDelivery({
      manifest: manifest("discord"),
      headers: {
        "x-signature-ed25519": "00".repeat(64),
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: BODY,
      secret: "not-hex-at-all",
    });
    expect(verdict).toMatchObject({ ok: false, reason: "this endpoint has no usable public key" });
  });
});

describe("a provider that sends the secret back (task 3.25)", () => {
  test("is taken when the header carries this endpoint's secret", async () => {
    const verdict = await verifyDelivery({
      manifest: manifest("cloudflare"),
      headers: { "cf-webhook-auth": SECRET },
      body: BODY,
      secret: SECRET,
    });
    expect(verdict.ok).toBe(true);
  });

  test("is refused when it carries somebody else's, or none", async () => {
    const cloudflare = manifest("cloudflare");
    const wrong = await verifyDelivery({
      manifest: cloudflare,
      headers: { "cf-webhook-auth": `${SECRET}-else` },
      body: BODY,
      secret: SECRET,
    });
    expect(wrong).toMatchObject({ ok: false, reason: "that secret is not this endpoint's" });
    const missing = await verifyDelivery({
      manifest: cloudflare,
      headers: {},
      body: BODY,
      secret: SECRET,
    });
    expect(missing).toMatchObject({ ok: false });
  });

  test("says nothing about the body, which is the point of the warning on it", async () => {
    // Not a bug: this is what Cloudflare and Google do. `perch connectors check` says so out loud.
    const verdict = await verifyDelivery({
      manifest: manifest("cloudflare"),
      headers: { "cf-webhook-auth": SECRET },
      body: '{"something":"else entirely"}',
      secret: SECRET,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("a Netlify delivery (task 3.25)", () => {
  test("is a JWS whose claims carry the body's digest", async () => {
    const netlify = manifest("netlify");
    const signature = await signDelivery({
      manifest: netlify,
      headers: {},
      body: BODY,
      secret: SECRET,
    });
    expect(signature.split(".")).toHaveLength(3);
    const verdict = await verifyDelivery({
      manifest: netlify,
      headers: { "x-webhook-signature": signature },
      body: BODY,
      secret: SECRET,
    });
    expect(verdict.ok).toBe(true);
  });

  test("is refused when the digest is not this body's, or the token is not signed with this secret", async () => {
    const netlify = manifest("netlify");
    const signature = await signDelivery({
      manifest: netlify,
      headers: {},
      body: BODY,
      secret: SECRET,
    });
    const otherBody = await verifyDelivery({
      manifest: netlify,
      headers: { "x-webhook-signature": signature },
      body: `${BODY} `,
      secret: SECRET,
    });
    expect(otherBody).toMatchObject({ ok: false });
    const otherSecret = await verifyDelivery({
      manifest: netlify,
      headers: { "x-webhook-signature": signature },
      body: BODY,
      secret: `${SECRET}-else`,
    });
    expect(otherSecret).toMatchObject({ ok: false });
  });

  test("is refused when the token says nothing about the body at all", async () => {
    // A JWS signed with the right secret but with no `sha256` claim would otherwise let any body
    // through once somebody had seen one real delivery.
    const text = new TextEncoder();
    const b64 = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const head = b64(text.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const claims = b64(text.encode(JSON.stringify({ iss: "netlify" })));
    const key = await crypto.subtle.importKey(
      "raw",
      text.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, text.encode(`${head}.${claims}`)),
    );
    const verdict = await verifyDelivery({
      manifest: manifest("netlify"),
      headers: { "x-webhook-signature": `${head}.${claims}.${b64(mac)}` },
      body: BODY,
      secret: SECRET,
    });
    expect(verdict).toMatchObject({ ok: false });
  });
});

describe("the secret Perch hands out", () => {
  test("is thirty-two bytes of hex, and never the same twice", () => {
    const one = webhookSecret();
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(webhookSecret()).not.toBe(one);
  });
});
