<#
EstateMate Bridge - installer with a diagnostic trail.

WHY THIS EXISTS
Double-clicking the MSI normally works: it is built, installed and uninstalled
on a Windows runner for every release. On a real estate PC, though, an MSI can
stop at the "Gathering information..." step and close with nothing installed and
no message. That silent stop is almost never the package: it is antivirus or
endpoint security ending msiexec, a Windows Installer service that cannot be
reached, a managed-machine policy that forbids MSIs, a download that never
finished, or a UAC prompt that was dismissed. None of those show an error, and
none of them can be told apart from the others by guessing.

This script makes the failure explainable and then gets the bridge installed
anyway:

  1. verifies the MSI against the SHA256SUMS.txt shipped beside it, so a
     half-downloaded file says so instead of failing mysteriously;
  2. removes the "downloaded from the Internet" mark and checks the Windows
     Installer service and free disk space before starting;
  3. runs msiexec with a verbose log, explains the exit code in plain English,
     and keeps the log beside the MSI for whoever looks next;
  4. if the MSI still cannot complete - policy, security software, a broken
     Windows Installer, a refused elevation prompt - falls back to a per-user
     install under %LOCALAPPDATA%\Programs that uses no Windows Installer and
     needs no administrator rights at all;
  5. -Uninstall removes the per-user install again.

The machine-wide MSI remains the recommended install; this script is the way to
see why it fails, and the way to keep working when it does.

USAGE (from an ordinary console; it elevates itself when it needs to)
  powershell -ExecutionPolicy Bypass -File .\install-bridge.ps1
  powershell -ExecutionPolicy Bypass -File .\install-bridge.ps1 -PerUser
  powershell -ExecutionPolicy Bypass -File .\install-bridge.ps1 -Uninstall

SWITCHES
  -MsiPath <file>   MSI to install (default: the one *.msi beside this script)
  -LogPath <file>   msiexec verbose log (default: %TEMP%\estatemate-bridge-*.log)
  -PerUser          skip the MSI: per-user copy install, no admin, no msiexec
  -Uninstall        remove a per-user copy install
  -Silent           no prompts, no MSI UI; exit codes only (used by CI)
  -NoFallback       do not offer the per-user install when the MSI fails
  -NoPause          never wait for Enter at the end
  -Elevated         internal: this process is already elevated
#>
[CmdletBinding()]
param(
  [string] $MsiPath,
  [string] $LogPath,
  [switch] $PerUser,
  [switch] $Uninstall,
  [switch] $Silent,
  [switch] $NoFallback,
  [switch] $NoPause,
  [switch] $Elevated
)

$ErrorActionPreference = 'Stop'

$script:InstallDir   = Join-Path $env:LOCALAPPDATA 'Programs\EstateMate Bridge'
$script:UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\EstateMateBridge'
$script:AppPathsKey  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\estatemate-bridge.exe'
$script:ShortcutDir  = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\EstateMate Bridge'
$script:MsiResolved  = $null
$script:StagingDir   = $null
$script:ExitCode     = 0

# --------------------------------------------------------------------- output ---

function Write-Head($text)  { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Write-Step($text)  { Write-Host "   $text" }
function Write-Ok($text)    { Write-Host "   [ok] $text" -ForegroundColor Green }
function Write-Warn($text)  { Write-Host "   [warn] $text" -ForegroundColor Yellow }
function Write-Bad($text)   { Write-Host "   [failed] $text" -ForegroundColor Red }

# --------------------------------------------------------------------- helpers ---

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-Sha256($file) {
  return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Clear-DownloadMark($file) {
  # A file saved from a browser carries a Zone.Identifier stream. Removing it is
  # what the Properties -> Unblock checkbox does, and it is the difference
  # between security software reading the file and refusing it.
  try {
    Unblock-File -LiteralPath $file -ErrorAction SilentlyContinue
    return $true
  } catch {
    return $false
  }
}

function Get-FreeSpaceMb($path) {
  try {
    $root = [System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $path).Path)
    $drive = New-Object System.IO.DriveInfo($root)
    return [int]($drive.AvailableFreeSpace / 1MB)
  } catch {
    return -1
  }
}

function Find-Msi {
  if ($MsiPath) {
    if (-not (Test-Path -LiteralPath $MsiPath)) { throw "the MSI was not found: $MsiPath" }
    return (Resolve-Path -LiteralPath $MsiPath).Path
  }
  $candidates = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'estatemate-bridge-*.msi' -File -ErrorAction SilentlyContinue)
  if ($candidates.Count -eq 0) { throw "no estatemate-bridge-*.msi beside this script ($PSScriptRoot); pass -MsiPath" }
  if ($candidates.Count -gt 1) {
    $newest = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Write-Warn "several MSIs are present; using $($newest.Name)"
    return $newest.FullName
  }
  return $candidates[0].FullName
}

function Test-MsiIntegrity($msi) {
  # The sums file ships in the same kit; when it is absent (someone passed
  # -MsiPath to a lone MSI) there is nothing to compare against.
  $sumsFile = Join-Path (Split-Path -Parent $msi) 'SHA256SUMS.txt'
  if (-not (Test-Path -LiteralPath $sumsFile)) {
    Write-Warn 'SHA256SUMS.txt not found next to the MSI; skipping the download-integrity check'
    return $true
  }
  $name = Split-Path -Leaf $msi
  $expected = $null
  foreach ($line in (Get-Content -LiteralPath $sumsFile)) {
    if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $name) {
      $expected = $Matches[1].ToLowerInvariant()
      break
    }
  }
  if (-not $expected) {
    Write-Warn "no checksum for $name in SHA256SUMS.txt; skipping the download-integrity check"
    return $true
  }
  $actual = Get-Sha256 $msi
  if ($actual -ne $expected) {
    Write-Bad 'the MSI does not match its checksum - the download is incomplete or was altered'
    Write-Step "expected sha256 $expected"
    Write-Step "actual   sha256 $actual"
    Write-Step 'download the MSI again (a browser that resumed an old download can leave a short file).'
    return $false
  }
  Write-Ok "sha256 verified: $($actual.Substring(0, 16))..."
  return $true
}

function Get-MsiFailureHelp($code) {
  switch ($code) {
    1601 { return 'The Windows Installer service could not be reached. Start it ("net start msiserver", or reboot) and run this again.' }
    1602 { return 'The installation was cancelled.' }
    1603 { return 'A fatal error during installation. The log kept beside the MSI names the failing step; antivirus or endpoint security is the usual cause.' }
    1618 { return 'Another installation is already running. Wait for it (or restart Windows) and run this again.' }
    1619 { return 'The MSI could not be opened - it is usually a file that did not finish downloading.' }
    1620 { return 'Windows says this is not a valid installation package - the MSI is corrupt. Download it again.' }
    1622 { return 'Windows could not write the installer log. Check that %TEMP% is writable, then run this again.' }
    1625 { return 'This installation is forbidden by system policy (a managed-machine restriction). The per-user install this script offers needs no policy permission.' }
    1633 { return 'This platform is not supported - the MSI is 64-bit and needs 64-bit Windows 10 or 11.' }
    1638 { return 'Another version of this product is already installed. Remove it in Settings - Apps first.' }
    1641 { return 'The installer started a restart. Restart Windows and run this again.' }
    1925 { return 'You do not have sufficient privileges for an all-users install. Sign in as an administrator, or use the per-user install.' }
    2502 { return 'The installer failed - usually a permissions problem with the TEMP folder or with the SYSTEM account.' }
    2503 { return 'The installer failed - usually a permissions problem with the TEMP folder or with the SYSTEM account.' }
    3010 { return 'Installed. Windows wants a restart to finish.' }
    default { return "Installation failed with exit code $code." }
  }
}

function Show-LogEvidence($log) {
  if (-not (Test-Path -LiteralPath $log)) { return }
  $matches = @(Select-String -LiteralPath $log -Pattern 'Return value 3|^\s*Error|ERROR_|Installation failed' -ErrorAction SilentlyContinue |
    Select-Object -Last 12)
  if ($matches.Count -gt 0) {
    Write-Step 'the installer log says:'
    foreach ($match in $matches) {
      $line = $match.Line.Trim()
      if ($line.Length -gt 150) { $line = $line.Substring(0, 150) + '...' }
      Write-Host "      $line" -ForegroundColor DarkGray
    }
  }
}

function Save-Evidence($msi, $log) {
  # Anything worth looking at is copied beside the MSI: the folder the person
  # already has open is the folder they can attach to a message.
  if (-not $msi) { return }
  $dir = Split-Path -Parent $msi
  if (-not (Test-Path -LiteralPath $dir)) { return }
  if ($log -and (Test-Path -LiteralPath $log)) {
    $copy = Join-Path $dir 'estatemate-bridge-install-log.txt'
    try { Copy-Item -LiteralPath $log -Destination $copy -Force; Write-Step "installer log kept at $copy" } catch { }
  }
}

# ------------------------------------------------------------ per-user install ---

function New-ConsoleShortcut($path, $arguments, $workingDirectory, $description) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($path)
  $shortcut.TargetPath = "$env:SystemRoot\System32\cmd.exe"
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $workingDirectory
  $shortcut.Description = $description
  $shortcut.Save()
}

function Get-PayloadExecutable($msi) {
  # The per-user install needs the bridge executable without msiexec performing
  # an install. Preferred order: the portable exe shipped in the same kit, then
  # an administrative extraction (msiexec /a), which unpacks the MSI's own
  # payload into a folder and changes nothing else on the machine.
  $portable = Join-Path $PSScriptRoot 'estatemate-bridge-win-x64.exe'
  if (Test-Path -LiteralPath $portable) {
    Write-Ok 'using the portable executable from this folder'
    return $portable
  }
  $staging = Join-Path ([System.IO.Path]::GetTempPath()) ('estatemate-bridge-extract-' + [Guid]::NewGuid().ToString('N'))
  $script:StagingDir = $staging
  Write-Step "unpacking the MSI into $staging (no installation, no administrator rights)"
  $proc = Start-Process msiexec.exe -ArgumentList @('/a', "`"$msi`"", '/qn', "TARGETDIR=`"$staging`"") -Wait -PassThru
  if ($proc.ExitCode -ne 0) {
    Write-Warn "msiexec /a could not unpack the payload (exit code $($proc.ExitCode))"
    return $null
  }
  $found = Get-ChildItem -LiteralPath $staging -Recurse -Filter 'estatemate-bridge.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) {
    Write-Warn 'the unpacked folder contained no estatemate-bridge.exe'
    return $null
  }
  return $found.FullName
}

function Install-PerUserCopy($msi) {
  Write-Head 'Per-user install (no administrator rights, no Windows Installer)'
  if (-not $msi) { $msi = Find-Msi }

  $payload = Get-PayloadExecutable $msi
  if (-not $payload) {
    Write-Bad 'no usable payload: neither the portable executable nor the MSI payload was available'
    return 4
  }

  New-Item -ItemType Directory -Force -Path $script:InstallDir | Out-Null
  $target = Join-Path $script:InstallDir 'estatemate-bridge.exe'
  Copy-Item -LiteralPath $payload -Destination $target -Force
  Write-Ok "installed $target"

  $readme = Join-Path (Split-Path -Parent $payload) 'README.txt'
  if (Test-Path -LiteralPath $readme) { Copy-Item -LiteralPath $readme -Destination $script:InstallDir -Force }

  # App Paths (HKCU): Win+R "estatemate-bridge" works without touching PATH.
  New-Item -Path $script:AppPathsKey -Force | Out-Null
  Set-ItemProperty -Path $script:AppPathsKey -Name '(default)' -Value $target
  Write-Ok 'registered the App Paths entry (Win+R "estatemate-bridge")'

  # User PATH: appended only when it stays well inside the Windows limit.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  if ($userPath -notlike "*$($script:InstallDir)*") {
    if ($userPath.Length -lt 8000) {
      $newPath = if ($userPath.Trim().Length -gt 0) { "$userPath;$($script:InstallDir)" } else { $script:InstallDir }
      [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
      Write-Ok 'added the install folder to your PATH (new consoles only)'
    } else {
      Write-Warn 'your PATH is already very long; skipped the PATH entry. Use the Start Menu shortcuts.'
    }
  }

  # Start Menu shortcuts that stay open, exactly like the MSI's.
  New-Item -ItemType Directory -Force -Path $script:ShortcutDir | Out-Null
  New-ConsoleShortcut (Join-Path $script:ShortcutDir 'EstateMate Bridge Console.lnk') '/K estatemate-bridge.exe help' $script:InstallDir 'Open a console for the EstateMate bridge commands'
  New-ConsoleShortcut (Join-Path $script:ShortcutDir 'Check configuration.lnk') '/K estatemate-bridge.exe check' $script:InstallDir 'Validate the config, the Worker and every terminal'
  New-ConsoleShortcut (Join-Path $script:ShortcutDir 'Service status.lnk') '/K estatemate-bridge.exe status' $script:InstallDir 'Paths, scheduled-task state and recent log lines'
  Write-Ok 'Start Menu shortcuts created'

  # So Windows' own "Installed apps" list can remove it again.
  New-Item -Path $script:UninstallKey -Force | Out-Null
  Set-ItemProperty -Path $script:UninstallKey -Name 'DisplayName' -Value 'EstateMate Bridge (per-user)'
  Set-ItemProperty -Path $script:UninstallKey -Name 'DisplayVersion' -Value 'per-user copy'
  Set-ItemProperty -Path $script:UninstallKey -Name 'Publisher' -Value 'EstateMate'
  Set-ItemProperty -Path $script:UninstallKey -Name 'InstallLocation' -Value $script:InstallDir
  Set-ItemProperty -Path $script:UninstallKey -Name 'NoModify' -Value 1 -Type DWord
  Set-ItemProperty -Path $script:UninstallKey -Name 'NoRepair' -Value 1 -Type DWord
  $selfCopy = Join-Path $script:InstallDir 'install-bridge.ps1'
  Copy-Item -LiteralPath $PSCommandPath -Destination $selfCopy -Force
  Set-ItemProperty -Path $script:UninstallKey -Name 'UninstallString' `
    -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$selfCopy`" -Uninstall"
  Write-Ok 'registered in Windows "Installed apps" as "EstateMate Bridge (per-user)"'

  if ($script:StagingDir -and (Test-Path -LiteralPath $script:StagingDir)) {
    Remove-Item -LiteralPath $script:StagingDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Head 'Next steps'
  Write-Step '1. Start Menu -> EstateMate Bridge -> "EstateMate Bridge Console"'
  Write-Step '2. estatemate-bridge.exe setup     (reads the portal''s Download setup script)'
  Write-Step '3. estatemate-bridge.exe check'
  Write-Step '4. From an Administrator console: estatemate-bridge.exe install-service'
  return 0
}

function Uninstall-PerUserCopy {
  Write-Head 'Removing the per-user install'
  if (Test-Path -LiteralPath $script:UninstallKey) { Remove-Item -Path $script:UninstallKey -Recurse -Force; Write-Ok 'removed the Installed apps entry' }
  if (Test-Path -LiteralPath $script:AppPathsKey) { Remove-Item -Path $script:AppPathsKey -Recurse -Force; Write-Ok 'removed the App Paths entry' }
  if (Test-Path -LiteralPath $script:ShortcutDir) { Remove-Item -LiteralPath $script:ShortcutDir -Recurse -Force; Write-Ok 'removed the Start Menu shortcuts' }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -like "*$($script:InstallDir)*") {
    $kept = @($userPath.Split(';') | Where-Object { $_ -and $_.TrimEnd('\') -ne $script:InstallDir.TrimEnd('\') })
    [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
    Write-Ok 'removed the install folder from your PATH'
  }
  if (Test-Path -LiteralPath $script:InstallDir) {
    Remove-Item -LiteralPath $script:InstallDir -Recurse -Force
    Write-Ok "deleted $script:InstallDir"
  }
  Write-Step 'Configuration and logs in %ProgramData%\EstateMate were left alone.'
  return 0
}

# ---------------------------------------------------------------- msi install ---

function Invoke-MsiInstall($msi, $log) {
  Write-Head 'Installing with Windows Installer (all users)'
  Write-Step "MSI:  $msi"
  Write-Step "log:  $log"

  if (-not (Test-Admin)) {
    Write-Warn 'an all-users install needs an administrator'
    return 1925
  }

  $service = Get-Service -Name 'msiserver' -ErrorAction SilentlyContinue
  if (-not $service) {
    Write-Bad 'the Windows Installer service is not installed on this PC'
    return 1601
  }
  if ($service.Status -ne 'Running') {
    Write-Step 'starting the Windows Installer service'
    try { Start-Service -Name 'msiserver' } catch { Write-Warn "could not start msiserver: $($_.Exception.Message)" }
  }

  $free = Get-FreeSpaceMb $msi
  if ($free -ge 0 -and $free -lt 400) {
    Write-Warn "only ${free} MB free on that drive; the install needs about 400 MB"
  }

  $arguments = @('/i', "`"$msi`"", '/l*v', "`"$log`"")
  if ($Silent) { $arguments += @('/qn', '/norestart') }
  Write-Step "running: msiexec.exe $($arguments -join ' ')"
  $proc = Start-Process msiexec.exe -ArgumentList $arguments -Wait -PassThru
  return $proc.ExitCode
}

function Start-Elevated {
  Write-Warn 'this needs administrator rights; asking Windows for them'
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated')
  if ($MsiPath) { $arguments += @('-MsiPath', "`"$MsiPath`"") }
  if ($LogPath) { $arguments += @('-LogPath', "`"$LogPath`"") }
  if ($Silent) { $arguments += '-Silent' }
  if ($NoFallback) { $arguments += '-NoFallback' }
  if ($NoPause) { $arguments += '-NoPause' }
  try {
    $proc = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    return $proc.ExitCode
  } catch {
    Write-Bad 'the administrator prompt was dismissed or refused'
    return 2
  }
}

# ------------------------------------------------------------------------ main ---

function Invoke-Main {
  Write-Host ''
  Write-Host 'EstateMate Bridge - installer' -ForegroundColor Cyan
  Write-Step "PowerShell $($PSVersionTable.PSVersion), $(if ([Environment]::Is64BitOperatingSystem) { '64-bit' } else { '32-bit' }) Windows $([Environment]::OSVersion.Version)"
  Write-Step "user: $env:USERNAME, administrator: $(if (Test-Admin) { 'yes' } else { 'no' })"

  if ($Uninstall) { return (Uninstall-PerUserCopy) }

  $msi = Find-Msi
  $script:MsiResolved = $msi
  Write-Step "MSI:  $msi"

  if ($PerUser) {
    if (-not (Test-MsiIntegrity $msi)) { return 3 }
    return (Install-PerUserCopy $msi)
  }

  if (-not (Clear-DownloadMark $msi)) { Write-Warn 'could not remove the download mark; continuing' }
  if (-not (Test-MsiIntegrity $msi)) { return 3 }
  if (-not (Test-Admin) -and -not $Elevated) { return (Start-Elevated) }

  if (-not $LogPath) {
    $LogPath = Join-Path ([System.IO.Path]::GetTempPath()) ('estatemate-bridge-install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
  }
  $code = Invoke-MsiInstall $msi $LogPath

  if ($code -eq 0 -or $code -eq 3010 -or $code -eq 1641) {
    Write-Ok "installed: $(Get-MsiFailureHelp $code)"
    $installed = Join-Path $env:ProgramFiles 'EstateMate Bridge\estatemate-bridge.exe'
    if (Test-Path -LiteralPath $installed) { Write-Ok "executable present: $installed" } else { Write-Warn "expected $installed but it is not there" }
    Write-Head 'Next steps'
    Write-Step '1. Start Menu -> EstateMate Bridge -> "EstateMate Bridge Console"'
    Write-Step '2. estatemate-bridge setup     (reads the portal''s Download setup script)'
    Write-Step '3. estatemate-bridge check'
    Write-Step '4. From an Administrator console: estatemate-bridge install-service'
    return $code
  }

  Write-Bad "the all-users install did not complete: $(Get-MsiFailureHelp $code)"
  Show-LogEvidence $LogPath
  Write-Step 'antivirus and endpoint security are the most common cause of a silent stop; the log above says where it stopped.'

  if ($NoFallback) { return $code }

  Write-Head 'Trying the per-user install instead'
  Write-Step 'it needs no administrator rights, uses no Windows Installer, and cannot be blocked by an MSI policy.'
  $fallback = Install-PerUserCopy $msi
  if ($fallback -eq 0) {
    Write-Ok 'the per-user install succeeded - the bridge is ready (the all-users install can be retried later).'
  } else {
    Write-Bad 'the per-user install did not complete either. Keep the MSI and the log file and ask for help with them.'
  }
  return $fallback
}

try {
  $script:ExitCode = Invoke-Main
} catch {
  Write-Bad "the installer stopped: $($_.Exception.Message)"
  if ($_.InvocationInfo -and $_.InvocationInfo.ScriptLineNumber) {
    Write-Step "at line $($_.InvocationInfo.ScriptLineNumber): $($_.InvocationInfo.Line.Trim())"
  }
  if ($_.ScriptStackTrace) { Write-Step "stack: $($_.ScriptStackTrace)" }
  $script:ExitCode = 1
}
if ($null -eq $script:ExitCode) { $script:ExitCode = 0 }
if ($script:ExitCode -isnot [int]) { $script:ExitCode = [int]($script:ExitCode | Select-Object -Last 1) }

if ($script:ExitCode -ne 0) {
  Save-Evidence $script:MsiResolved $LogPath
  if ($script:ExitCode -eq 3) { Write-Step 'nothing was installed: the MSI you have is not the file that was published.' }
}

if (-not $NoPause -and -not $Silent) {
  Write-Host ''
  Read-Host 'Press Enter to close this window' | Out-Null
}

exit $script:ExitCode
