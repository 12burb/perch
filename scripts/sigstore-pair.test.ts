import { describe, expect, test } from "bun:test";
import { pairFromBundle, toPem } from "./sigstore-pair.ts";

/**
 * Taking the detached pair out of a Sigstore bundle.
 *
 * What is worth testing is that it reads both shapes Sigstore bundles have had, that it copies
 * rather than re-encodes, and — most of all — that a bundle it does not understand is an error
 * rather than an empty file, because an empty `SHA256SUMS.sig` in a release is a signature that
 * silently verifies nothing.
 */

const DER = "MIIBfakecertificatebytesx".repeat(9);
const SIG = "MEUCIQDfakesignaturebytes+/=";

const newShape = {
  mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
  verificationMaterial: { certificate: { rawBytes: DER }, tlogEntries: [{ logIndex: "1" }] },
  messageSignature: { messageDigest: { algorithm: "SHA2_256", digest: "abc" }, signature: SIG },
};

const oldShape = {
  verificationMaterial: { x509CertificateChain: { certificates: [{ rawBytes: DER }] } },
  messageSignature: { signature: SIG },
};

describe("the detached pair out of a bundle", () => {
  test("PEM is the base64 in lines of 64, between the markers", () => {
    const pem = toPem("a".repeat(130));
    const lines = pem.trimEnd().split("\n");
    expect(lines[0]).toBe("-----BEGIN CERTIFICATE-----");
    expect(lines.at(-1)).toBe("-----END CERTIFICATE-----");
    expect(lines.slice(1, -1).map((one) => one.length)).toEqual([64, 64, 2]);
    // Whitespace in the source is not part of the encoding.
    expect(toPem("aa\nbb ")).toContain("aabb");
  });

  test("it reads the bundle cosign writes today", () => {
    const pair = pairFromBundle(newShape);
    expect(pair.signature).toBe(SIG);
    expect(pair.certificatePem).toContain("BEGIN CERTIFICATE");
    expect(pair.certificatePem.replace(/-.*-|\n/g, "")).toBe(DER);
  });

  test("and the older chain shape", () => {
    expect(pairFromBundle(oldShape).signature).toBe(SIG);
  });

  test("a bundle it cannot read is an error, never an empty file", () => {
    expect(() => pairFromBundle(null)).toThrow(/not an object/);
    expect(() => pairFromBundle({})).toThrow(/verificationMaterial/);
    expect(() => pairFromBundle({ verificationMaterial: {} })).toThrow(/signing certificate/);
    expect(() =>
      pairFromBundle({ verificationMaterial: { certificate: { rawBytes: DER } } }),
    ).toThrow(/messageSignature/);
    expect(() =>
      pairFromBundle({
        verificationMaterial: { certificate: { rawBytes: DER } },
        dsseEnvelope: { payload: "x" },
      }),
    ).toThrow(/DSSE/);
    // An empty string is not a signature.
    expect(() =>
      pairFromBundle({
        verificationMaterial: { certificate: { rawBytes: DER } },
        messageSignature: { signature: "" },
      }),
    ).toThrow(/messageSignature/);
  });
});
