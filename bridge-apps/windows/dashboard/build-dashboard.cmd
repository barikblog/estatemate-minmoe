@echo off
setlocal
rem Builds EstateMateBridge.exe - the GUI launcher for the dashboard (no console).
rem
rem   build-dashboard.cmd [output-directory]
rem
rem Called by scripts/package-bridge-msi.mjs on the Windows runner, and handy by
rem hand when working on the dashboard. It finds a C# compiler the machine
rem already has: the one in Visual Studio if present, otherwise the one in the
rem .NET Framework directory (which is part of Windows).
set "HERE=%~dp0"
set "OUT=%~1"
if "%OUT%"=="" set "OUT=%HERE%"
set "SOURCE=%HERE%Launcher.cs"
if not exist "%SOURCE%" (
  echo Launcher.cs was not found next to build-dashboard.cmd.
  exit /b 2
)

set "CSC="
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
  set "VS="
  for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.Component.MSBuild -property installationPath 2^>nul`) do set "VS=%%i"
  if defined VS (
    for /f "delims=" %%c in ('dir /b /s "%VS%\MSBuild\Current\Bin\Roslyn\csc.exe" 2^>nul') do set "CSC=%%c"
  )
)
if not defined CSC if exist "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" set "CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not defined CSC if exist "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe" set "CSC=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not defined CSC (
  echo No C# compiler found on this machine ^(looked in Visual Studio and in the .NET Framework directory^).
  exit /b 3
)

echo Compiling %SOURCE%
echo   with %CSC%
"%CSC%" /nologo /target:winexe /optimize+ /platform:anycpu /out:"%OUT%EstateMateBridge.exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "%SOURCE%"
if errorlevel 1 (
  echo Compiling the dashboard launcher failed.
  exit /b 1
)
echo Wrote %OUT%EstateMateBridge.exe
exit /b 0
