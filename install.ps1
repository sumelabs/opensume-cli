# Install opensume, the Sume Open API CLI, on Windows.
#
#   irm https://raw.githubusercontent.com/sumelabs/opensume-cli/main/install.ps1 | iex
#
# Settings (environment variables):
#   OPENSUME_VERSION      a release like 0.1.0 (default: the latest)
#   OPENSUME_INSTALL_DIR  where the binary goes (default: %LOCALAPPDATA%\opensume\bin)
#
# The download is checked against the release's checksums.txt (SHA-256)
# before anything is installed.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'sumelabs/opensume-cli'
$InstallDir = if ($env:OPENSUME_INSTALL_DIR) { $env:OPENSUME_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'opensume\bin' }

if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'opensume needs 64-bit Windows.'
}

if ($env:OPENSUME_VERSION) {
  $Version = $env:OPENSUME_VERSION.TrimStart('v')
} else {
  $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'opensume-install' }
  $Version = $Release.tag_name.TrimStart('v')
}
if ($Version -notmatch '^\d+\.\d+\.\d+') { throw "No published release found at https://github.com/$Repo/releases" }

# Windows on Arm runs the x64 build through emulation.
$Asset = 'opensume-windows-x64.exe'
$Base = "https://github.com/$Repo/releases/download/v$Version"
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("opensume-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Temp | Out-Null

try {
  Write-Host "Downloading opensume $Version (windows x64)..."
  Invoke-WebRequest -Uri "$Base/$Asset" -OutFile (Join-Path $Temp $Asset) -UseBasicParsing
  Invoke-WebRequest -Uri "$Base/checksums.txt" -OutFile (Join-Path $Temp 'checksums.txt') -UseBasicParsing

  $Expected = $null
  foreach ($Line in Get-Content (Join-Path $Temp 'checksums.txt')) {
    if ($Line -match '^([0-9a-fA-F]{64})\s+\*?(\S+)$' -and $Matches[2] -eq $Asset) {
      $Expected = $Matches[1].ToLower()
      break
    }
  }
  if (-not $Expected) { throw "checksums.txt has no entry for $Asset" }
  $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Temp $Asset)).Hash.ToLower()
  if ($Expected -ne $Actual) { throw "Checksum mismatch for $Asset; nothing was installed." }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $Target = Join-Path $InstallDir 'opensume.exe'
  if (Test-Path $Target) {
    # A running opensume.exe cannot be overwritten, but it can be renamed.
    Move-Item -Force $Target "$Target.old"
  }
  Move-Item -Force (Join-Path $Temp $Asset) $Target
  Write-Host "Installed opensume $Version to $Target" -ForegroundColor Green
} finally {
  Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($UserPath -split ';') -contains $InstallDir)) {
  $NewPath = if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }
  [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
  $env:Path = "$env:Path;$InstallDir"
  Write-Host "Added $InstallDir to your PATH. Open a new terminal to use it everywhere."
}

Write-Host ''
Write-Host 'Next: create a key at https://open.sume.com/api-keys, then'
Write-Host '  opensume auth login'
Write-Host '  opensume run gpt-image-2 "a ceramic cup on a wooden table" -q low'
