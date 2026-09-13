#!/usr/bin/env bun
/**
 * Spike 0.4.10 — verifies that a public URL served by the cloudflared tunnel reaches the api: an OAuth
 * callback (GET with code and state) and an inbound webhook (POST with a body) both arrive. Needs the
 * compose stack in this directory running with a real TUNNEL_TOKEN whose public hostname routes to
 * http://api:3000, and PERCH_PUBLIC_URL set to that hostname.
 */
const publicUrl = process.env.PERCH_PUBLIC_URL;
if (!publicUrl || !process.env.TUNNEL_TOKEN) {
  console.log(
    "skipped: PERCH_PUBLIC_URL and TUNNEL_TOKEN are not set (spike 0.4.10 needs a Cloudflare tunnel)",
  );
  process.exit(0);
}
const callback = await fetch(`${publicUrl}/connect/callback/github?code=spike&state=spike`);
const webhook = await fetch(`${publicUrl}/hooks/github/spike`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=spike" },
  body: JSON.stringify({ action: "opened" }),
});
console.log(`callback: ${callback.status} ${await callback.text()}`);
console.log(`webhook: ${webhook.status} ${await webhook.text()}`);
if (!callback.ok || !webhook.ok) {
  console.error("the tunnel did not deliver both requests to the api");
  process.exit(1);
}
console.log("cloudflared tunnel verified: callback and webhook reached the api");
