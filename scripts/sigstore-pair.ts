#!/usr/bin/env bun
/**
 * The detached signature and certificate, out of a Sigstore bundle.
 *
 * cosign 3 signs into a bundle and refuses the old `--output-signature` / `--output-certificate`
 * pair outright ("must provide --new-bundle-format or --bundle …"). The pair is still what
 * `install.sh` and `perch upgrade` verify with — including the copies already on people's machines
 * — so the release takes the bundle cosign will produce and writes the pair out of it.
 *
 * Nothing is re-signed and nothing is trusted on the way: the signature and the certificate are
 * lifted verbatim out of the bundle, and the release workflow then has cosign verify both forms
 * before anything is published.
 *
 * Usage: bun scripts/sigstore-pair.ts <bundle.json> <out.sig> <out.pem>
 */
import { readFileSync, writeFileSync } from "node:fs";

export type Pair = {
  /** Base64, exactly as `--output-signature` used to write it. */
  signature: string;
  /** The signing certificate, PEM-encoded. */
  certificatePem: string;
};

/** PEM is base64 in lines of 64, between the two markers. */
export function toPem(derBase64: string, label = "CERTIFICATE"): string {
  const body = derBase64.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

type Unknown = Record<string, unknown>;
const object = (value: unknown): Unknown | undefined =>
  typeof value === "object" && value !== null ? (value as Unknown) : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** The certificate a bundle carries, in either of the two shapes Sigstore has used. */
function certificateOf(material: Unknown): string | undefined {
  const single = text(object(material.certificate)?.rawBytes);
  if (single) return single;
  const chain = object(material.x509CertificateChain)?.certificates;
  if (!Array.isArray(chain)) return undefined;
  return text(object(chain[0])?.rawBytes);
}

export function pairFromBundle(bundle: unknown): Pair {
  const root = object(bundle);
  if (!root) throw new Error("the bundle is not an object");
  const material = object(root.verificationMaterial);
  if (!material) throw new Error("the bundle has no verificationMaterial");
  const certificate = certificateOf(material);
  if (!certificate) throw new Error("the bundle carries no signing certificate");
  const signature = text(object(root.messageSignature)?.signature);
  if (!signature) {
    // A DSSE envelope signs an attestation rather than a blob; nothing here produces one, and
    // guessing at its signature would publish something that verifies against the wrong payload.
    throw new Error(
      root.dsseEnvelope
        ? "this is a DSSE bundle, which has no detached signature over the blob"
        : "the bundle carries no messageSignature",
    );
  }
  return { signature, certificatePem: toPem(certificate) };
}

const asCommand = /sigstore-pair\.ts$/.test(process.argv[1] ?? "");

if (asCommand) {
  const [, , bundlePath, sigPath, pemPath] = process.argv;
  if (!bundlePath || !sigPath || !pemPath) {
    console.error("usage: bun scripts/sigstore-pair.ts <bundle.json> <out.sig> <out.pem>");
    process.exit(2);
  }
  const pair = pairFromBundle(JSON.parse(readFileSync(bundlePath, "utf8")));
  writeFileSync(sigPath, pair.signature);
  writeFileSync(pemPath, pair.certificatePem);
  console.log(`wrote ${sigPath} (${pair.signature.length} chars) and ${pemPath}`);
}
