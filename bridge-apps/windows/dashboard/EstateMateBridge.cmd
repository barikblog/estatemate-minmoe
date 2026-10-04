@echo off
rem EstateMate Bridge - opens the dashboard window (no console, no commands to type).
rem Kept for the installer kit and for anyone who wants a shortcut of their own:
rem the Start Menu entry installed by the MSI launches the same script.
setlocal
set "DASHBOARD=%~dp0EstateMateBridge.ps1"
if not exist "%DASHBOARD%" set "DASHBOARD=%~dp0dashboard\EstateMateBridge.ps1"
if not exist "%DASHBOARD%" (
  echo EstateMateBridge.ps1 was not found next to this launcher.
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%DASHBOARD%" %*
exit /b %ERRORLEVEL%
