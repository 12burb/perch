import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "../src/manifest.ts";
import { verifyDelivery, webhookSecret } from "../src/webhooks.ts";

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

describe("the secret Perch hands out", () => {
  test("is thirty-two bytes of hex, and never the same twice", () => {
    const one = webhookSecret();
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(webhookSecret()).not.toBe(one);
  });
});
