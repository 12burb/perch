---
"@perch/cli": patch
---

Security: a scan that runs when nobody has pushed, an SBOM for the binaries, and a disclosure drill
that is a test.

A daily `security.yml` runs Trivy over every lockfile in the repository and over the published
images — the advisory published a week after a dependency was merged is the one a per-push scan
cannot catch. CI now scans the runner image as well as the api image, in the job that already
builds it.

Each release carries `sbom-perch-<version>.spdx.json`, an SPDX bill of materials for the source the
binaries were built from. It is listed in `SHA256SUMS`, so the existing cosign signature covers it:
a tampered SBOM fails the same check a tampered binary does.

`docs/security.md` is the disclosure drill, and `bun run drill` walks it: the private reporting
path, the clock, the scans, the signature, the SBOMs and the tamper tests are all asserted on every
`bun run check`, so none of them can quietly disappear.
