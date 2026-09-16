#!/bin/sh
# Perch's installer (task 4.3). One binary, checksum-checked, on your PATH:
#
#   curl -fsSL https://raw.githubusercontent.com/12burb/perch/main/install.sh | sh
#
# Options, as environment variables:
#   PERCH_VERSION=v0.2.0        install that release instead of the newest
#   PERCH_INSTALL_DIR=…         where to put it (default: /usr/local/bin when writable, else ~/.local/bin)
#   PERCH_REPO=owner/repo       somewhere other than 12burb/perch
#   PERCH_REQUIRE_SIGNATURE=1   stop unless cosign can verify the release's signature
#   PERCH_RELEASES_API=… / PERCH_DOWNLOAD_BASE=…   a mirror, or a stand-in release server in a test
#
# It never installs what it cannot check: the binary must match the SHA256SUMS the release
# published, or nothing is written. Those checksums are themselves signed by the release workflow
# (cosign, keyless), and the signature is checked too when cosign is on this machine.
set -eu

repo="${PERCH_REPO:-12burb/perch}"
api="${PERCH_RELEASES_API:-https://api.github.com/repos/${repo}/releases}"
identity="^https://github\.com/${repo}/\.github/workflows/release\.yml@"
issuer="https://token.actions.githubusercontent.com"

say() { printf '%s\n' "$*" >&2; }
die() { say "perch: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "this installer needs $1"; }

need curl

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  *) die "there is no Perch binary for $os — on Windows run install.ps1" ;;
esac
case "$arch" in
  x86_64 | amd64) cpu=x64 ;;
  arm64 | aarch64) cpu=arm64 ;;
  *) die "there is no Perch binary for $arch" ;;
esac
asset="perch-${platform}-${cpu}"

version="${PERCH_VERSION:-}"
if [ -z "$version" ]; then
  version="$(curl -fsSL "${api}/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$version" ] || die "could not work out the newest release from ${api}/latest"
fi
base="${PERCH_DOWNLOAD_BASE:-https://github.com/${repo}/releases/download}/${version}"

dir="${PERCH_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -w /usr/local/bin ] 2>/dev/null; then dir=/usr/local/bin; else dir="$HOME/.local/bin"; fi
fi
mkdir -p "$dir"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "perch: downloading ${asset} ${version}"
curl -fsSL -o "$tmp/$asset" "${base}/${asset}" || die "could not download ${base}/${asset}"
curl -fsSL -o "$tmp/SHA256SUMS" "${base}/SHA256SUMS" || die "that release published no SHA256SUMS"

# The checksum is the whole point of this script: nothing is installed unless it matches.
expected="$(grep -E "[[:space:]]\*?${asset}\$" "$tmp/SHA256SUMS" | awk '{print $1}' | head -n 1)"
[ -n "$expected" ] || die "SHA256SUMS has no line for ${asset}"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
else
  die "this installer needs sha256sum or shasum"
fi
[ "$expected" = "$actual" ] || die "${asset} does not match the checksum ${version} published"

# And the signature over those checksums, where this machine can check it.
signed=no
if curl -fsSL -o "$tmp/SHA256SUMS.sig" "${base}/SHA256SUMS.sig" 2>/dev/null &&
  curl -fsSL -o "$tmp/SHA256SUMS.pem" "${base}/SHA256SUMS.pem" 2>/dev/null; then
  if command -v cosign >/dev/null 2>&1; then
    cosign verify-blob \
      --signature "$tmp/SHA256SUMS.sig" \
      --certificate "$tmp/SHA256SUMS.pem" \
      --certificate-identity-regexp "$identity" \
      --certificate-oidc-issuer "$issuer" \
      "$tmp/SHA256SUMS" >/dev/null 2>&1 ||
      die "the signature over SHA256SUMS is not ${repo}'s release workflow; nothing was installed"
    signed=yes
    say "perch: the checksums are signed by ${repo}'s release workflow"
  else
    say "perch: the checksum matched; install cosign to check the signature too"
  fi
else
  say "perch: that release published no signature over its checksums"
fi
if [ "${PERCH_REQUIRE_SIGNATURE:-}" = "1" ] && [ "$signed" != "yes" ]; then
  die "PERCH_REQUIRE_SIGNATURE is set and the signature could not be checked; nothing was installed"
fi

chmod +x "$tmp/$asset"
mv "$tmp/$asset" "$dir/perch"
say "perch: installed ${version} to ${dir}/perch"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "perch: add ${dir} to your PATH to run it by name" ;;
esac
say "perch: next — perch dev   (laptop mode on this machine)"
