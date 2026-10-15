# Install opensume, the Sume Open API CLI, on Windows.
#
#   irm https://raw.githubusercontent.com/sumelabs/opensume-cli/main/install.ps1 | iex
#
# Settings (environment variables):
#   OPENSUME_VERSION          a release like 0.1.0 (default: the latest)
#   OPENSUME_INSTALL_DIR      where the binary goes (default: %LOCALAPPDATA%\opensume\bin)
#   OPENSUME_NO_MODIFY_PATH   set to 1 to leave your PATH alone
#
# The download is checked against the release's checksums.txt (SHA-256)
# before anything is installed. Works in Windows PowerShell 5.1 and PowerShell 7.

# Run in a child scope so `irm | iex` leaves nothing behind in your session.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  # Windows PowerShell 5.1 may default to TLS 1.0, which GitHub refuses.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

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
  $Temp = Join-Path ([IO.Path]::GetTempPath()) ('opensume-' + [Guid]::NewGuid())
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
    $Old = "$Target.old"
    if (Test-Path $Old) { Remove-Item -Force $Old -ErrorAction SilentlyContinue }
    if (Test-Path $Target) {
      # A running opensume.exe cannot be overwritten, but it can be renamed.
      Move-Item -Force $Target $Old
    }
    try {
      Move-Item -Force (Join-Path $Temp $Asset) $Target
    } catch {
      if (Test-Path $Old) { Move-Item -Force $Old $Target }
      throw
    }
    Write-Host "Installed opensume $Version to $Target" -ForegroundColor Green
  } finally {
    Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
  }

  if ($env:OPENSUME_NO_MODIFY_PATH -eq '1') {
    Write-Host "Add $InstallDir to your PATH to run opensume from anywhere."
  } else {
    # Edit the raw registry value so entries like %USERPROFILE%\bin stay unexpanded.
    $Key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $UserPath = [string]$Key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if (-not (($UserPath -split ';') -contains $InstallDir)) {
        $NewPath = if ($UserPath) { "$($UserPath.TrimEnd(';'));$InstallDir" } else { $InstallDir }
        $Key.SetValue('Path', $NewPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        # Setting any user variable through .NET tells open programs the environment changed.
        [Environment]::SetEnvironmentVariable('OPENSUME_PATH_REFRESH', '1', 'User')
        [Environment]::SetEnvironmentVariable('OPENSUME_PATH_REFRESH', $null, 'User')
        Write-Host "Added $InstallDir to your PATH. Open a new terminal to use it everywhere."
      }
    } finally {
      $Key.Close()
    }
    if (-not (($env:Path -split ';') -contains $InstallDir)) { $env:Path = "$env:Path;$InstallDir" }
  }

  Write-Host ''
  Write-Host 'Next:'
  Write-Host '  $env:SUME_API_KEY = "..."   # a person makes it at https://open.sume.com/api-keys (or put it in .\.env)'
  Write-Host '  opensume init               # tell this project''s coding agents about opensume'
  Write-Host '  opensume run gpt-image-2 "a ceramic cup on a wooden table" -q low'
}
