@echo off
setlocal
rem Builds EstateMateBridge.exe - the GUI launcher for the dashboard (no console).
rem
rem   build-dashboard.cmd [output-exe]
rem
rem The argument is the full path of the .exe to write (default: next to this
rem script). scripts/package-bridge-msi.mjs calls this on the Windows runner;
rem running it by hand gives you a launcher for the folder you are in.
rem
rem It finds a C# compiler the machine already has: the one in Visual Studio if
rem present, otherwise the one in the .NET Framework directory (part of Windows).
set "HERE=%~dp0"
set "SOURCE=%HERE%Launcher.cs"
rem The output path can be given as an argument or in ESTATEMATE_DASHBOARD_OUT.
rem The packaging script uses the variable: it passes no argument at all, so
rem there is no quoting for cmd.exe to get wrong on a path with spaces.
set "OUTEXE=%~1"
if "%OUTEXE%"=="" set "OUTEXE=%ESTATEMATE_DASHBOARD_OUT%"
if "%OUTEXE%"=="" set "OUTEXE=%HERE%EstateMateBridge.exe"

if not exist "%SOURCE%" (
  echo build-dashboard.cmd: Launcher.cs was not found next to this script.
  exit /b 2
)

set "CSC="
set "VS="
rem 1) Visual Studio's Roslyn compiler, located through vswhere. Written as
rem    one-line `if` statements on purpose: a variable set inside a parenthesised
rem    block is not visible to another command in the same block without delayed
rem    expansion, which is the classic way a batch script silently finds nothing.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.Component.MSBuild -property installationPath 2^>nul`) do set "VS=%%i"
if defined VS for /f "delims=" %%c in ('dir /b /s "%VS%\MSBuild\Current\Bin\Roslyn\csc.exe" 2^>nul') do set "CSC=%%c"
rem 2) Visual Studio without vswhere (some managed machines).
if not defined CSC for /f "delims=" %%c in ('dir /b /s "%ProgramFiles%\Microsoft Visual Studio\2022\*\MSBuild\Current\Bin\Roslyn\csc.exe" 2^>nul') do set "CSC=%%c"
rem 3) The compiler inside the .NET Framework, which every Windows has.
if not defined CSC if exist "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" set "CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not defined CSC if exist "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe" set "CSC=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe"

if not defined CSC (
  echo build-dashboard.cmd: no C# compiler found on this machine
  echo   looked in Visual Studio ^(vswhere, then Program Files^) and in the .NET Framework directory.
  exit /b 3
)

echo build-dashboard.cmd: source      %SOURCE%
echo build-dashboard.cmd: output      %OUTEXE%
echo build-dashboard.cmd: compiler    %CSC%
"%CSC%" /nologo /target:winexe /optimize+ /platform:anycpu /out:"%OUTEXE%" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "%SOURCE%"
if errorlevel 1 (
  echo build-dashboard.cmd: the compiler failed ^(see its messages above^).
  exit /b 1
)
if not exist "%OUTEXE%" (
  echo build-dashboard.cmd: the compiler reported success but %OUTEXE% was not written.
  exit /b 1
)
for %%f in ("%OUTEXE%") do echo build-dashboard.cmd: wrote %%f (%%~zf bytes^)
exit /b 0
