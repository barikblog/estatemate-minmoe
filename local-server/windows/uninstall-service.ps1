# EstateMate offline server - remove the boot task and firewall rule.
[CmdletBinding()]
param(
    [string]$TaskName = 'EstateMateOfflineServer'
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error 'Run this script as Administrator.'
}

schtasks.exe /End /TN $TaskName 2>$null | Out-Null
schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Could not delete the scheduled task '$TaskName' (it may not exist)."
}

Get-NetFirewallRule -DisplayName 'EstateMate Offline Server' -ErrorAction SilentlyContinue | Remove-NetFirewallRule

Write-Host 'Removed the boot task and firewall rule. The database and uploads in local-server\data are untouched.'
