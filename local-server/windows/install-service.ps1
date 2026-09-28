# EstateMate offline server - Windows start-at-boot setup.
#
# Run once in an elevated PowerShell on the estate office PC:
#
#   powershell -ExecutionPolicy Bypass -File local-server\windows\install-service.ps1
#
# It registers a boot scheduled task (same mechanism as the EstateMate
# Windows agent) that runs start-server.cmd with automatic restart, opens
# the portal port in Windows Firewall, and starts the server immediately.
[CmdletBinding()]
param(
    [string]$TaskName = 'EstateMateOfflineServer',
    [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error 'Run this script as Administrator (right-click PowerShell, Run as administrator).'
}

$serverDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$wrapper = Join-Path $serverDir 'windows\start-server.cmd'
$configFile = Join-Path $serverDir 'config.json'

if (-not (Test-Path -LiteralPath $wrapper)) {
    Write-Error "start-server.cmd not found at $wrapper"
}
if (-not (Test-Path -LiteralPath $configFile)) {
    Write-Warning "No config.json yet ($configFile)."
    Write-Warning 'Start the server once first (node local-server\server.mjs) so it is generated, then re-run this script.'
}

$taskAction = "`"$wrapper`""
schtasks.exe /Create /TN $TaskName /SC ONSTART /RU SYSTEM /RL HIGHEST /F /TR $taskAction | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "schtasks /Create failed with exit code $LASTEXITCODE."
}

$existingRule = Get-NetFirewallRule -DisplayName 'EstateMate Offline Server' -ErrorAction SilentlyContinue
if ($existingRule) {
    $existingRule | Remove-NetFirewallRule
}
New-NetFirewallRule -DisplayName 'EstateMate Offline Server' `
    -Description 'Inbound portal access to the EstateMate offline LAN server' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null

schtasks.exe /Run /TN $TaskName | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Warning 'Could not start the task now; it will start on next boot. Check with: schtasks /Query /TN ' + $TaskName
}

Write-Host ''
Write-Host "Installed. The estate portal will now be served on port $Port at every boot,"
Write-Host "at http://<this-pc-lan-ip>:$Port for everyone on the estate LAN."
Write-Host ''
Write-Host "Status:      schtasks /Query /TN $TaskName /V /FO LIST"
Write-Host "Stop:        schtasks /End   /TN $TaskName"
Write-Host "Uninstall:   powershell -ExecutionPolicy Bypass -File local-server\windows\uninstall-service.ps1"
