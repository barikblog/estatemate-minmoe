/**
 * The Raspberry Pi bridge setup script the portal hands out for a Pi bridge
 * agent ("Runs on: Raspberry Pi (bridge)"), next to the Windows PowerShell and
 * the generic Linux/macOS shell scripts in src/index.ts.
 *
 * The generic Linux script stops at "now create a systemd unit yourself". A Pi
 * is usually a headless box with nothing on it, so this one does the whole job
 * unattended:
 *
 *   * installs Node 22 (arm64 or armv7l) if the Pi does not already have it;
 *   * installs the bridge from the public repository tarball;
 *   * writes agent-config.json (0600) and an isapi-devices.json to edit;
 *   * installs and starts a systemd service that comes back on boot.
 *
 * Everything it fetches is public and pinned to a ref that can be overridden
 * (`ESTATEMATE_BRIDGE_REF`); nothing but the agent secret in the config file is
 * private, and that file is only readable by root. Generating this file rotates
 * the agent secret (src/index.ts), exactly like every other setup file.
 */

export const PI_BRIDGE_SERVICE_NAME = 'estatemate-isapi-agent';

export interface PiBridgeSetupInput {
  agent: { id: string; name: string };
  secret: string;
  installerKey: string;
  workerUrl: string;
  generatedAt: Date;
  /** Repository the bridge is fetched from; overridable in the script. */
  repo?: string;
  ref?: string;
}

/** Text that is safe inside a shell double-quoted string. */
function shellText(value: string): string {
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/["$`\\]/g, '').trim().slice(0, 120);
}

export function renderPiBridgeSetupScript(input: PiBridgeSetupInput): string {
  const { agent, secret, installerKey, workerUrl, generatedAt } = input;
  const repo = input.repo ?? 'barikblog/estatemate-minmoe';
  const ref = input.ref ?? 'main';
  const name = shellText(agent.name);
  return `#!/bin/bash
# EstateMate Raspberry Pi ISAPI Bridge Agent setup
# Agent:    ${name} (${agent.id})
# Portal:   ${shellText(workerUrl)}
# Generated ${generatedAt.toISOString()} - the installer key below expires in 24 hours.
#
# Run this on the Raspberry Pi itself, as root (or with sudo):
#
#   curl -fsSL <this file> -o setup.sh && sudo bash setup.sh
#
# It installs Node 22 (arm64/armv7l), the bridge, the agent configuration and a
# systemd service that starts the bridge on boot. It downloads public files
# only; the agent secret never leaves the Pi's own config file.
set -euo pipefail

AGENT_ID="${shellText(agent.id)}"
AGENT_SECRET="${shellText(secret)}"
INSTALLER_KEY="${shellText(installerKey)}"
WORKER_URL="${shellText(workerUrl)}"
BRIDGE_REPO="\${ESTATEMATE_BRIDGE_REPO:-${shellText(repo)}}"
BRIDGE_REF="\${ESTATEMATE_BRIDGE_REF:-${shellText(ref)}}"
NODE_MAJOR="22"
INSTALL_DIR="/opt/estatemate/isapi-agent"
SERVICE_NAME="${PI_BRIDGE_SERVICE_NAME}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo: it installs a systemd service." >&2
  exit 1
fi

echo "EstateMate Raspberry Pi bridge setup"
echo "Agent:    ${name} (${agent.id})"
echo "Portal:   ${shellText(workerUrl)}"
echo "Install:  $INSTALL_DIR"

# ---------------------------------------------------------------------------
# 1. Node 22 (arm64 / armv7l), only when it is missing or too old
# ---------------------------------------------------------------------------
node_major() {
  if command -v node >/dev/null 2>&1; then node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; else echo 0; fi
}
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  case "$(uname -m)" in
    aarch64|arm64) NODE_ARCH="arm64" ;;
    armv7l|armv8l) NODE_ARCH="armv7l" ;;
    *)
      echo "Unsupported architecture $(uname -m): this installer covers 64-bit and 32-bit Raspberry Pi OS." >&2
      exit 1
      ;;
  esac
  echo "Installing Node $NODE_MAJOR for $NODE_ARCH..."
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates xz-utils
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  # The index is authoritative: take the current linux-<arch> tarball name from it.
  NODE_FILE="$(curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/" | grep -o "node-v$NODE_MAJOR\\.[0-9.]*-linux-$NODE_ARCH\\.tar\\.xz" | head -1)"
  if [ -z "$NODE_FILE" ]; then
    echo "Could not find a Node $NODE_MAJOR build for $NODE_ARCH on nodejs.org." >&2
    exit 1
  fi
  curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/$NODE_FILE" -o "$TMP/$NODE_FILE"
  ( cd "$TMP" && grep " $NODE_FILE\$" SHASUMS256.txt | sha256sum -c - )
  tar -xJf "$TMP/$NODE_FILE" -C /usr/local --strip-components=1 --no-same-owner
  echo "Node $(node --version) installed."
else
  echo "Node $(node --version) is already installed."
fi

# ---------------------------------------------------------------------------
# 2. The bridge itself, from the public repository tarball
# ---------------------------------------------------------------------------
echo "Downloading the bridge ($BRIDGE_REPO@$BRIDGE_REF)..."
TMP_BRIDGE="$(mktemp -d)"
trap 'rm -rf "\${TMP:-}" "\${TMP_BRIDGE:-}"' EXIT
curl -fsSL "https://codeload.github.com/$BRIDGE_REPO/tar.gz/refs/heads/$BRIDGE_REF" -o "$TMP_BRIDGE/bridge.tar.gz"
tar -xzf "$TMP_BRIDGE/bridge.tar.gz" -C "$TMP_BRIDGE"
mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/logs"
cp -a "$TMP_BRIDGE"/*/isapi-bridge/. "$INSTALL_DIR/"
echo "Bridge files installed in $INSTALL_DIR (agent.mjs, remote-verify.mjs, ...)."

# ---------------------------------------------------------------------------
# 3. Configuration (root-only: it holds the agent secret)
# ---------------------------------------------------------------------------
umask 077
cat > "$INSTALL_DIR/agent-config.json" <<EOF
{
  "agentId": "$AGENT_ID",
  "agentSecret": "$AGENT_SECRET",
  "installerKey": "$INSTALLER_KEY",
  "workerUrl": "$WORKER_URL",
  "syncIntervalSeconds": 30,
  "heartbeatIntervalSeconds": 60,
  "logLevel": "info"
}
EOF
chmod 0600 "$INSTALL_DIR/agent-config.json"
echo "Wrote $INSTALL_DIR/agent-config.json (0600)."

if [ ! -f "$INSTALL_DIR/isapi-devices.json" ]; then
  cat > "$INSTALL_DIR/isapi-devices.json" <<'EOF'
{
  "devices": [
    {
      "estateMateDeviceId": "DEVICE_UUID_FROM_PORTAL",
      "isapiHost": "192.168.1.100",
      "isapiPort": 80,
      "isapiUsername": "admin",
      "isapiPassword": "device-admin-password",
      "protocol": "http"
    }
  ]
}
EOF
  chmod 0600 "$INSTALL_DIR/isapi-devices.json"
  echo "Created $INSTALL_DIR/isapi-devices.json - edit it with your terminal IPs and ISAPI logins."
fi

# ---------------------------------------------------------------------------
# 4. systemd service, started now and on every boot
# ---------------------------------------------------------------------------
NODE_BIN="$(command -v node)"
cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=EstateMate ISAPI Bridge Agent
Documentation=file://$INSTALL_DIR/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/agent.mjs --config $INSTALL_DIR/agent-config.json --devices $INSTALL_DIR/isapi-devices.json
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
echo "Service $SERVICE_NAME installed and started."

cat <<'NEXT'

Next steps
----------
1. Link each terminal to this agent in the portal (Device agent > Connect terminal),
   or edit /opt/estatemate/isapi-agent/isapi-devices.json with the LAN addresses and
   ISAPI logins, then: sudo systemctl restart estatemate-isapi-agent
2. Watch it work:   sudo journalctl -u estatemate-isapi-agent -f
3. The agent turns online in the portal within a minute. Keep the terminals and
   this Pi on the same VLAN and never expose ISAPI ports to the Internet.

Security: /opt/estatemate/isapi-agent/agent-config.json holds the agent secret and
is readable by root only. Downloading a new setup file rotates that secret, so an
older file (and any bridge configured from it) stops being accepted.
NEXT
`;
}
