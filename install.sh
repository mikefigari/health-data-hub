#!/usr/bin/env bash
# install.sh — Install the health-data-hub systemd service
#
# Run once (or re-run to update) as the user who owns the project.
# Must be run with sudo for systemctl commands.
#
# Usage:
#   chmod +x install.sh
#   sudo ./install.sh

set -euo pipefail

SERVICE_NAME="health-data-hub"
UNIT_FILE="$(dirname "$(realpath "$0")")/${SERVICE_NAME}.service"
SYSTEMD_DIR="/etc/systemd/system"

# ── Preflight checks ──────────────────────────────────────────────────────────

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: This script must be run with sudo." >&2
  exit 1
fi

if [[ ! -f "$UNIT_FILE" ]]; then
  echo "ERROR: Unit file not found at: $UNIT_FILE" >&2
  exit 1
fi

# ── Install ───────────────────────────────────────────────────────────────────

echo "Installing ${SERVICE_NAME}.service ..."
cp "$UNIT_FILE" "${SYSTEMD_DIR}/${SERVICE_NAME}.service"
chmod 644 "${SYSTEMD_DIR}/${SERVICE_NAME}.service"

echo "Reloading systemd daemon ..."
systemctl daemon-reload

echo "Enabling service (start on boot) ..."
systemctl enable "${SERVICE_NAME}.service"

echo "Starting service ..."
systemctl start "${SERVICE_NAME}.service"

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  Installation complete."
echo ""
echo "  Useful commands:"
echo "    Status:    sudo systemctl status ${SERVICE_NAME}"
echo "    Live logs: sudo journalctl -u ${SERVICE_NAME} -f"
echo "    Stop:      sudo systemctl stop ${SERVICE_NAME}"
echo "    Restart:   sudo systemctl restart ${SERVICE_NAME}"
echo "    Disable:   sudo systemctl disable ${SERVICE_NAME}"
echo "══════════════════════════════════════════════════════════"
echo ""
systemctl status "${SERVICE_NAME}.service" --no-pager
