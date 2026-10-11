@echo off
setlocal
rem Builds EstateMateHikSdk.exe - the helper that links Hikvision's Device
rem Network SDK (HCNetSDK.dll) so the EstateMate agent can reach a terminal on
rem its SDK/"server" port, the way iVMS-4200 does.
rem
rem   build-hcnetsdk-helper.cmd [output-exe]
rem
rem Nothing to install: like the dashboard launcher, this uses a C# compiler the
rem machine already has. The helper is written in C# 5 for that reason.
rem
rem The vendor library is NOT part of this repository. Download Hikvision's
rem Device Network SDK from hikvision.com (free, with registration) and put
rem HCNetSDK.dll and the HCNetSDKCom folder next to the built .exe - see
rem README.md in this folder.
set "HERE=%~dp0"
set "OUTEXE=%~1"
if "%OUTEXE%"=="" set "OUTEXE=%ESTATEMATE_HCNETSDK_OUT%"
if "%OUTEXE%"=="" set "OUTEXE=%HERE%build\EstateMateHikSdk.exe"

if not exist "%HERE%EstateMateHikSdk.cs" (
  echo build-hcnetsdk-helper.cmd: EstateMateHikSdk.cs was not found next to this script.
  exit /b 2
)

rem Everything in this folder is compiled: the helper, its native bindings and
rem its JSON reader. Adding a file to this folder must never require editing this
rem script - see the note in scripts/ci-checks.sh about module drift.
set "SOURCES="
for %%f in ("%HERE%*.cs") do call set "SOURCES=%%SOURCES%% ""%%f"""
if "%SOURCES%"=="" (
  echo build-hcnetsdk-helper.cmd: no .cs files found in %HERE%.
  exit /b 2
)

set "CSC="
set "VS="
rem The same compiler search as bridge-apps/windows/dashboard/build-dashboard.cmd:
rem Visual Studio's Roslyn compiler if present, otherwise the one inside the
rem .NET Framework directory that every Windows installation has. Written as
rem one-line `if` statements on purpose: a variable set inside a parenthesised
rem block is not visible to another command in the same block without delayed
rem expansion.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.Component.MSBuild -property installationPath 2^>nul`) do set "VS=%%i"
if defined VS for /f "delims=" %%c in ('dir /b /s "%VS%\MSBuild\Current\Bin\Roslyn\csc.exe" 2^>nul') do set "CSC=%%c"
if not defined CSC for /f "delims=" %%c in ('dir /b /s "%ProgramFiles%\Microsoft Visual Studio\2022\*\MSBuild\Current\Bin\Roslyn\csc.exe" 2^>nul') do set "CSC=%%c"
if not defined CSC if exist "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" set "CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not defined CSC if exist "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe" set "CSC=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe"

if not defined CSC (
  echo build-hcnetsdk-helper.cmd: no C# compiler found on this machine
  echo   looked in Visual Studio ^(vswhere, then Program Files^) and in the .NET Framework directory.
  exit /b 3
)

if not exist "%HERE%build" mkdir "%HERE%build" >nul 2>nul

echo build-hcnetsdk-helper.cmd: output   %OUTEXE%
echo build-hcnetsdk-helper.cmd: compiler %CSC%
"%CSC%" /nologo /target:exe /optimize+ /platform:anycpu /out:"%OUTEXE%" %SOURCES%
if errorlevel 1 (
  echo build-hcnetsdk-helper.cmd: the compiler failed ^(see its messages above^).
  exit /b 1
)
if not exist "%OUTEXE%" (
  echo build-hcnetsdk-helper.cmd: the compiler reported success but %OUTEXE% was not written.
  exit /b 1
)
for %%f in ("%OUTEXE%") do echo build-hcnetsdk-helper.cmd: wrote %%f (%%~zf bytes^)
echo.
echo Next: copy HCNetSDK.dll and the HCNetSDKCom folder from Hikvision's Device
echo Network SDK next to that .exe, then run:
echo   "%OUTEXE%" --selftest ^<device-address^>:8000 admin "the-password"
exit /b 0
