#!/usr/bin/env bun
/**
 * Spike 0.4.8 — verifies the DNS-challenge wildcard certificate once the compose stack is up with real
 * credentials. Prints the certificate subject alternative names for a preview host and exits non-zero
 * unless `*.<PERCH_PREVIEW_DOMAIN>` is among them.
 */
const domain = process.env.PERCH_PREVIEW_DOMAIN;
const host = process.env.PERCH_SPIKE_CADDY_HOST ?? "127.0.0.1";
if (!domain) {
  console.log(
    "skipped: PERCH_PREVIEW_DOMAIN is not set (spike 0.4.8 needs a real domain and DNS token)",
  );
  process.exit(0);
}
const probe = `5173--spike.${domain}`;
const proc = Bun.spawnSync([
  "sh",
  "-c",
  `echo | openssl s_client -connect ${host}:443 -servername ${probe} 2>/dev/null | openssl x509 -noout -ext subjectAltName`,
]);
const out = proc.stdout.toString();
console.log(out.trim());
if (!out.includes(`DNS:*.${domain}`)) {
  console.error(`no wildcard certificate for *.${domain} was served for ${probe}`);
  process.exit(1);
}
console.log(`wildcard certificate for *.${domain} verified`);
