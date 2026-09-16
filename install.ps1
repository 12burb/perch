# Perch's installer for Windows (task 4.3). One binary, checksum-checked, on your PATH:
#
#   irm https://raw.githubusercontent.com/12burb/perch/main/install.ps1 | iex
#
# Options, as environment variables: PERCH_VERSION, PERCH_INSTALL_DIR, PERCH_REPO,
# PERCH_REQUIRE_SIGNATURE=1, and PERCH_RELEASES_API / PERCH_DOWNLOAD_BASE for a mirror.
#
# Nothing is installed that does not match the SHA256SUMS the release published. Those checksums
# are signed by the release workflow (cosign, keyless), and the signature is checked too when
# cosign is on this machine.
$ErrorActionPreference = 'Stop'

$repo = if ($env:PERCH_REPO) { $env:PERCH_REPO } else { '12burb/perch' }
$asset = 'perch-windows-x64.exe'
$api = if ($env:PERCH_RELEASES_API) { $env:PERCH_RELEASES_API } else { "https://api.github.com/repos/$repo/releases" }

$version = $env:PERCH_VERSION
if (-not $version) {
  $latest = Invoke-RestMethod "$api/latest"
  $version = $latest.tag_name
}
if (-not $version) { throw 'perch: could not work out the newest release' }
$downloads = if ($env:PERCH_DOWNLOAD_BASE) { $env:PERCH_DOWNLOAD_BASE } else { "https://github.com/$repo/releases/download" }
$base = "$downloads/$version"

$dir = $env:PERCH_INSTALL_DIR
if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA 'Perch\bin' }
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Write-Host "perch: downloading $asset $version"
  Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp $asset)
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')

  # The checksum is the whole point of this script.
  $line = Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match "\s\*?$([regex]::Escape($asset))$" } | Select-Object -First 1
  if (-not $line) { throw "perch: SHA256SUMS has no line for $asset" }
  $expected = ($line -split '\s+')[0].ToLower()
  $actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) { throw "perch: $asset does not match the checksum $version published" }

  # And the signature over those checksums, where this machine can check it.
  $signed = $false
  $haveBundle = $true
  foreach ($suffix in 'sig', 'pem') {
    try { Invoke-WebRequest "$base/SHA256SUMS.$suffix" -OutFile (Join-Path $tmp "SHA256SUMS.$suffix") }
    catch { $haveBundle = $false }
  }
  $cosign = Get-Command cosign -ErrorAction SilentlyContinue
  if ($haveBundle -and $cosign) {
    $identity = "^https://github\.com/$([regex]::Escape($repo))/\.github/workflows/release\.yml@"
    & $cosign.Source verify-blob `
      --signature (Join-Path $tmp 'SHA256SUMS.sig') `
      --certificate (Join-Path $tmp 'SHA256SUMS.pem') `
      --certificate-identity-regexp $identity `
      --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' `
      (Join-Path $tmp 'SHA256SUMS') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "perch: the signature over SHA256SUMS is not $repo's release workflow; nothing was installed" }
    $signed = $true
    Write-Host "perch: the checksums are signed by $repo's release workflow"
  } elseif ($haveBundle) {
    Write-Host 'perch: the checksum matched; install cosign to check the signature too'
  } else {
    Write-Host 'perch: that release published no signature over its checksums'
  }
  if ($env:PERCH_REQUIRE_SIGNATURE -eq '1' -and -not $signed) {
    throw 'perch: PERCH_REQUIRE_SIGNATURE is set and the signature could not be checked; nothing was installed'
  }

  Move-Item -Force (Join-Path $tmp $asset) (Join-Path $dir 'perch.exe')
  Write-Host "perch: installed $version to $dir\perch.exe"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($path -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable('Path', "$path;$dir", 'User')
  Write-Host "perch: added $dir to your PATH (open a new terminal for it to take)"
}
Write-Host 'perch: next - perch dev   (laptop mode on this machine)'
