@echo off
rem ===========================================================================
rem  EstateMate Bridge - double-click installer.
rem
rem  Runs install-bridge.ps1, which installs the MSI next to this file, shows
rem  why the MSI fails when it does, and falls back to a per-user install that
rem  needs no administrator rights and no Windows Installer.  See the script's
rem  header for the whole story.
rem
rem  Keep this file, install-bridge.ps1, the MSI and SHA256SUMS.txt together in
rem  one folder - that is what "estatemate-bridge-*-installer-kit.zip" is.
rem ===========================================================================
setlocal
set "SCRIPT=%~dp0install-bridge.ps1"
if not exist "%SCRIPT%" (
  echo.
  echo   install-bridge.ps1 was not found next to this file:
  echo     %SCRIPT%
  echo.
  echo   Unzip the whole installer kit first, then double-click this file inside it.
  echo.
  pause
  exit /b 1
)

rem Automation (the release smoke test) passes -Silent/-NoPause and must never
rem be left waiting for a keypress, so only an interactive run pauses.
set "QUIET="
echo %* | findstr /i /c:"-silent" /c:"-nopause" /c:"/silent" /c:"/qn" >nul && set "QUIET=1"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" if not defined QUIET (
  echo.
  echo   The installer exited with code %CODE%.
  echo   The messages above say what happened; the log kept beside the MSI has
  echo   the details.  Nothing was installed if it says "nothing was installed".
  echo.
  echo   You can also try the portable executable instead: it needs no installer.
  echo.
  pause
)

exit /b %CODE%
