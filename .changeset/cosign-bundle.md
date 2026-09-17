---
"@perch/api": patch
---

Releases keep signing their checksums after cosign 3 changed what `sign-blob` writes by default.
The detached `SHA256SUMS.sig` and `SHA256SUMS.pem` are asked for by name, so every `install.sh` and
`perch upgrade` already on a machine keeps verifying, and a `SHA256SUMS.bundle` is published beside
them for verifiers that want the newer Sigstore bundle.
