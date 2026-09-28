@echo off
rem EstateMate offline LAN server - restart-loop wrapper for the boot task.
rem The scheduled task created by install-service.ps1 runs this file; if the
rem server process ever exits (crash, power event), it starts again after a
rem short pause so the estate gates keep their portal and event flow.
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install the Node.js LTS MSI from
  echo https://nodejs.org/  and make sure "Add to PATH" stays checked.
  pause
  exit /b 1
)

:loop
node local-server\server.mjs --config local-server\config.json
echo [%DATE% %TIME%] EstateMate server exited with code %ERRORLEVEL%. Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
