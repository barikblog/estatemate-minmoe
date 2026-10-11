#!/usr/bin/env bash
# Builds the Hikvision SDK helper on Linux/macOS: dotnet build -c Release.
#
# Hikvision ships the Device Network SDK for Windows and Linux; there is no
# macOS library, so a Mac can build this but has no libhcnetsdk.so to load.
#
#   ./build-hcnetsdk-helper.sh
#
# After it runs, put libhcnetsdk.so (and Hikvision's other .so files) in the same
# folder as the built helper — see README.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

if ! command -v dotnet >/dev/null 2>&1; then
  echo "build-hcnetsdk-helper.sh: the .NET SDK (dotnet) is not installed." >&2
  echo "  Install it from https://dotnet.microsoft.com/download, or run the agent's Windows helper instead." >&2
  exit 3
fi

dotnet build -c Release "$here/EstateMateHikSdk.csproj"
echo
echo "Built $here/build/EstateMateHikSdk"
echo "Next: copy libhcnetsdk.so (and Hikvision's other SDK .so files) next to it, then run:"
echo "  $here/build/EstateMateHikSdk --selftest <device-address>:8000 admin 'the-password'"
