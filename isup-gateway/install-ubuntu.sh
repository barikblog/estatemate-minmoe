#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-install}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR=/opt/estatemate-isup-control
CONFIG_DIR=/etc/estatemate
STATE_DIR=/var/lib/estatemate-isup
LOG_DIR=/var/log/estatemate-isup
ENV_FILE="$CONFIG_DIR/isup-gateway.env"
DEVICE_FILE="$CONFIG_DIR/isup-devices.json"
ADAPTER_DEVICE_FILE="$CONFIG_DIR/isup-adapter.json"

if [[ ${EUID} -ne 0 ]]; then echo "Run this script with sudo." >&2; exit 1; fi
if [[ ! "$ACTION" =~ ^(install|start|status|uninstall)$ ]]; then
  echo "Usage: sudo $0 [install|start|status|uninstall]" >&2
  exit 2
fi

install_gateway() {
  . /etc/os-release
  if [[ ${ID:-} != ubuntu ]]; then echo "This installer targets Ubuntu; detected ${ID:-unknown}." >&2; exit 1; fi
  architecture="$(dpkg --print-architecture)"
  echo "Installing EstateMate ISUP gateway host files on Ubuntu ${VERSION_ID:-unknown} (${architecture})."
  if [[ "$architecture" != amd64 ]]; then
    echo "WARNING: Confirm that the supplied Hikvision Linux ISUP SDK supports ${architecture}; many SDK bundles are amd64-only." >&2
  fi

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl jq openssl docker.io
  if ! docker compose version >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2 2>/dev/null || \
      DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin
  fi
  systemctl enable --now docker

  getent group estatemate-isup >/dev/null || groupadd --system estatemate-isup
  id estatemate-isup >/dev/null 2>&1 || useradd --system --gid estatemate-isup --home-dir "$STATE_DIR" --shell /usr/sbin/nologin estatemate-isup
  install -d -o root -g root -m 0755 "$INSTALL_DIR" "$CONFIG_DIR"
  install -d -o estatemate-isup -g estatemate-isup -m 0750 "$STATE_DIR" "$LOG_DIR"
  install -m 0644 "$SOURCE_DIR/package.json" "$SOURCE_DIR/server.mjs" "$SOURCE_DIR/Dockerfile" "$SOURCE_DIR/compose.yaml" "$SOURCE_DIR/SDK-ADAPTER-CONTRACT.md" "$SOURCE_DIR/isup-gateway.env.example" "$SOURCE_DIR/isup-devices.example.json" "$SOURCE_DIR/isup-adapter.example.json" "$INSTALL_DIR/"
  install -m 0755 "$SOURCE_DIR/install-ubuntu.sh" "$INSTALL_DIR/"
  install -m 0644 "$SOURCE_DIR/estatemate-isup-adapter.service" /etc/systemd/system/estatemate-isup-adapter.service

  if [[ ! -f "$ENV_FILE" ]]; then
    adapter_secret="$(openssl rand -hex 32)"
    sed "s/replace-with-at-least-32-random-characters/$adapter_secret/" "$SOURCE_DIR/isup-gateway.env.example" > "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
  fi
  if [[ ! -f "$DEVICE_FILE" ]]; then
    install -m 0600 "$SOURCE_DIR/isup-devices.example.json" "$DEVICE_FILE"
  fi
  if [[ ! -f "$ADAPTER_DEVICE_FILE" ]]; then
    install -o root -g estatemate-isup -m 0640 "$SOURCE_DIR/isup-adapter.example.json" "$ADAPTER_DEVICE_FILE"
  fi

  systemctl daemon-reload
  echo
  echo "Host files installed. Before starting:"
  echo "  1. Create an EstateMate device using the off-site ISUP gateway connection pattern."
  echo "  2. Put its UUID and one-time device secret in $DEVICE_FILE, then chmod 600 that file."
  echo "  3. Put each terminal's SDK device ID, matching localDeviceId and ISUP key in $ADAPTER_DEVICE_FILE."
  echo "  4. Install the licensed adapter executable at /opt/hikvision-isup/bin/estatemate-isup-adapter."
  echo "  5. Install matching SDK libraries under /opt/hikvision-isup/lib."
  echo "  6. Run: sudo $0 start"
}

start_gateway() {
  [[ -f "$ENV_FILE" && -f "$DEVICE_FILE" && -f "$ADAPTER_DEVICE_FILE" ]] || { echo "Run the install action first." >&2; exit 1; }
  jq -e '.devices | length > 0 and all(.[]; (.estateMateDeviceId | test("^[0-9a-fA-F-]{36}$")) and .estateMateDeviceId != "00000000-0000-0000-0000-000000000000" and (.deviceKey | length >= 32))' "$DEVICE_FILE" >/dev/null || {
    echo "Configure real EstateMate device mappings in $DEVICE_FILE first." >&2; exit 1;
  }
  jq -e '.devices | length > 0 and all(.[]; (.sdkDeviceId | length > 0) and (.localDeviceId | test("^[A-Za-z0-9._-]{1,80}$")) and (.isupKey | length >= 12) and (.isupKey | contains("replace-with") | not))' "$ADAPTER_DEVICE_FILE" >/dev/null || {
    echo "Configure real SDK device IDs and unique ISUP keys in $ADAPTER_DEVICE_FILE first." >&2; exit 1;
  }
  control_ids="$(jq -r '.devices[].localDeviceId' "$DEVICE_FILE" | sort -u)"
  adapter_ids="$(jq -r '.devices[].localDeviceId' "$ADAPTER_DEVICE_FILE" | sort -u)"
  [[ "$control_ids" == "$adapter_ids" ]] || { echo "localDeviceId values must match in both device files." >&2; exit 1; }
  [[ -x /opt/hikvision-isup/bin/estatemate-isup-adapter ]] || {
    echo "The official-SDK adapter executable is missing at /opt/hikvision-isup/bin/estatemate-isup-adapter." >&2
    echo "See $SOURCE_DIR/SDK-ADAPTER-CONTRACT.md." >&2
    exit 1
  }
  chown -R estatemate-isup:estatemate-isup /opt/hikvision-isup "$STATE_DIR" "$LOG_DIR"
  chown root:root "$ENV_FILE" "$DEVICE_FILE"
  chmod 0600 "$ENV_FILE" "$DEVICE_FILE"
  chown root:estatemate-isup "$ADAPTER_DEVICE_FILE"
  chmod 0640 "$ADAPTER_DEVICE_FILE"

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  registration_port="${ISUP_REGISTRATION_PORT:-7660}"
  alarm_port="${ISUP_ALARM_PORT:-7332}"
  for value in "$registration_port" "$alarm_port"; do
    [[ "$value" =~ ^[0-9]+$ ]] && (( value >= 1024 && value <= 65535 )) || { echo "Invalid ISUP port: $value" >&2; exit 1; }
  done

  docker compose -f "$INSTALL_DIR/compose.yaml" build --pull
  docker compose -f "$INSTALL_DIR/compose.yaml" up -d
  systemctl enable --now estatemate-isup-adapter.service

  if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
    ufw allow "${registration_port}/tcp" comment 'Hikvision ISUP registration'
    ufw allow "${alarm_port}/tcp" comment 'Hikvision ISUP alarms'
  else
    echo "UFW is not active. Open TCP ${registration_port} and ${alarm_port} in the VM firewall/security list."
  fi
  echo "Gateway started. The SDK adapter owns public TCP ports; the control API remains loopback-only."
  echo "Check: sudo $0 status"
}

status_gateway() {
  docker compose -f "$INSTALL_DIR/compose.yaml" ps 2>/dev/null || true
  systemctl --no-pager --full status estatemate-isup-adapter.service || true
  curl -fsS http://127.0.0.1:8788/health | jq . || true
}

uninstall_gateway() {
  systemctl disable --now estatemate-isup-adapter.service 2>/dev/null || true
  docker compose -f "$INSTALL_DIR/compose.yaml" down 2>/dev/null || true
  rm -f /etc/systemd/system/estatemate-isup-adapter.service
  systemctl daemon-reload
  echo "Services removed. Secrets, SDK files and state were deliberately retained under $CONFIG_DIR, /opt/hikvision-isup and $STATE_DIR."
}

case "$ACTION" in
  install) install_gateway ;;
  start) start_gateway ;;
  status) status_gateway ;;
  uninstall) uninstall_gateway ;;
esac
