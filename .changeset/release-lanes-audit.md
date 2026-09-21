---
"@perch/cli": patch
---

`perch upgrade` refuses to run from the npm package or a checkout instead of replacing the Bun
binary it is running on, and says how to upgrade that install; the npm bundle carries the version
it was built as, so `npx perch-dev version` answers and `perch upgrade --check` compares against
it; `perch init` pins images to the compiled version first. In the release: npm publish runs
before the flake and formula refresh (which rebases and retries), the docs site's deploy is
started explicitly (a release made with `GITHUB_TOKEN` starts no workflow by itself), and the
flake patches the binary's ELF interpreter so `nix run` works on NixOS too.
