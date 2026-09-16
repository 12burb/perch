---
"@perch/cli": minor
---

Install anywhere, and upgrade in place. `curl -fsSL .../install.sh | sh` on macOS and Linux, `irm
.../install.ps1 | iex` on Windows: one binary, on your PATH, in a few seconds. `perch upgrade`
replaces the binary that is running it with the newest release — `--check` to look first, `--force`
to reinstall the version already there.

Nothing is installed that the release did not vouch for. The download must match the release's own
`SHA256SUMS`, and those checksums are now signed by the release workflow with cosign (keyless,
Sigstore): the signature is verified when cosign is on the machine, and
`PERCH_REQUIRE_SIGNATURE=1` (or `perch upgrade --require-signature`) refuses an install that cannot
be checked that far. A tampered binary installs nothing at all and leaves the Perch you had.

Every release also publishes the package-manager manifests, generated from that release's own
checksums so they cannot drift from what was built: a Homebrew formula, the three winget files, an
AUR `PKGBUILD` and a nix `flake.nix`. `docs/install.md` has the lot, including how to check a
download by hand.
