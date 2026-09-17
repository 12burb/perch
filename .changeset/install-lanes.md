---
"@perch/cli": patch
---

`nix run github:12burb/perch` works: there is a `flake.nix` at the root of the repository now,
generated from the newest release's own checksums and refreshed by the release workflow. The install
docs also say which of the other package-manager lanes actually work today — Homebrew, winget, the
AUR and npm all ship a generated manifest each release, but none of them is published to its
registry yet, and `docs/install.md` no longer reads as though they are.
