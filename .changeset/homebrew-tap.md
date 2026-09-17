---
"@perch/cli": patch
---

Homebrew works now, without waiting for a tap repository: `Formula/perch.rb` lives in this
repository, so `brew tap 12burb/perch https://github.com/12burb/perch && brew install
12burb/perch/perch` installs the signed release binary. The release workflow refreshes it — and
`flake.nix` — on the default branch, and a test holds the two to the same version and the same
checksums so one cannot be updated without the other.
