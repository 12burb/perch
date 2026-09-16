# Installing Perch

Perch is one file. There is no installer to click through, no account to make, and nothing to pay
for: you download a binary, run `perch dev`, and you have a Perch (task 4.3).

## The one-liners

**macOS and Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/12burb/perch/main/install.sh | sh
perch dev
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/12burb/perch/main/install.ps1 | iex
perch dev
```

Both scripts work out which binary this machine wants, download it from the newest release, check
it, and put it somewhere on your PATH. Then `perch dev` runs api, web and an in-process runner on
PGlite in `~/.perch` (`%USERPROFILE%\.perch` on Windows) and prints a URL.

| Variable | What it does |
|---|---|
| `PERCH_VERSION` | install that release (`v0.2.0`) instead of the newest |
| `PERCH_INSTALL_DIR` | where to put the binary (default `/usr/local/bin` when writable, else `~/.local/bin`; `%LOCALAPPDATA%\Perch\bin` on Windows) |
| `PERCH_REQUIRE_SIGNATURE=1` | stop unless cosign can verify the release's signature |
| `PERCH_REPO` | install from a fork |
| `PERCH_RELEASES_API`, `PERCH_DOWNLOAD_BASE` | a mirror, or a stand-in release server in a test |

## What is checked before anything is written

Nothing is installed that the release did not vouch for. The installers and `perch upgrade` do the
same two checks, in the same order:

1. **The checksum.** Every release publishes `SHA256SUMS` alongside the binaries. The downloaded
   file must match the line for its name, or the installer stops and writes nothing.
2. **The signature over those checksums.** The release workflow signs `SHA256SUMS` with cosign
   (keyless, Sigstore), publishing `SHA256SUMS.sig` and `SHA256SUMS.pem`. When cosign is on the
   machine, the signature is verified and must name *this repository's release workflow*, through
   GitHub's OIDC issuer — a signature by anybody else fails the install.

Without cosign installed the checksum still holds and the installer says so rather than pretending.
`PERCH_REQUIRE_SIGNATURE=1` (or `perch upgrade --require-signature`) turns that into a refusal, which
is the right setting for a machine that matters.

By hand, the same check:

```sh
cosign verify-blob SHA256SUMS \
  --signature SHA256SUMS.sig --certificate SHA256SUMS.pem \
  --certificate-identity-regexp '^https://github\.com/12burb/perch/\.github/workflows/release\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
sha256sum -c SHA256SUMS --ignore-missing
```

## Package managers

Every release publishes the manifests for these, generated from that release's own checksums by
`scripts/packaging.ts`, so none of them can drift from what was actually built:

| | |
|---|---|
| **Homebrew** | `brew install 12burb/perch/perch` (the tap carries `perch.rb` from the release) |
| **winget** | `winget install Perch.Perch` |
| **AUR** | `yay -S perch-bin` (the release's `PKGBUILD`) |
| **nix** | `nix run github:12burb/perch` with the release's `flake.nix`, or `nix profile install` it |
| **npm** | `npx perch-dev@latest dev` — needs Bun, and is the one lane where the web app is copied beside the script rather than embedded |

## Upgrading

```sh
perch upgrade            # replace this binary with the newest release
perch upgrade --check    # say what the newest release is and stop
perch upgrade --force    # reinstall the version already here
perch upgrade --require-signature
```

`perch upgrade` replaces **the binary that is running it**, in place: the new one is staged beside
it, the running one is renamed to `perch.old`, the new one is moved into its place, and the old one
is removed. If anything fails at the last step the old binary goes back, so a failed upgrade leaves
a working Perch. (The rename is also what makes this work on Windows, where a running executable
cannot be overwritten but can be moved.)

An upgrade never touches `~/.perch`, so your data, projects and workspaces survive it. Stop
`perch dev` first if it is running, the same as you would for any other program you are replacing.

Installed through a package manager? Upgrade through it instead — `brew upgrade perch`,
`winget upgrade Perch.Perch` — so its own record of what is installed stays true.

## Uninstalling

Delete the binary (`rm "$(command -v perch)"`) and, if you want the data gone too, `~/.perch`. Perch
writes nothing else: no services, no launch agents, no registry keys beyond the PATH entry
`install.ps1` adds on Windows.

## Team mode

The one-liners install laptop mode. For a team on a server, see [`deploy.md`](deploy.md): `perch
init` writes a `docker-compose.yml`, a `Caddyfile` and an `.env`, and the images are signed the same
way ([`ci.md`](ci.md)).
